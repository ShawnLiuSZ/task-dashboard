#!/usr/bin/env python3
"""PR 合并后的自动清理：删除源分支 + 关闭关联 issue（Issue #284）。

由 `.github/workflows/merge-cleanup.yml` 在 PR 合并到 develop / main 后调用，替代
「合并完还得手动删分支、手动关 issue」的人工收尾。

关联 issue 的提取规则（详见 `extract_issue_refs`）：
  * PR 正文只认**带关闭关键词的引用**（Closes / Fixes / Resolves / Refs / 关闭 / 解决
    / 修复…），避免把正文里引用的历史 issue 号（如 CHANGELOG 里的「沿用 #155/#175
    教训」）误判成要关闭的 issue；
  * PR 标题里任何 `#N` 都算（标题通常就是 `... (#284)` 这一处主旨引用）。

安全护栏：
  * 源分支属于 fork（`head.repo.full_name != repository.full_name`）时跳过删除；
  * 标题含 `test` / `draft`（大小写不敏感）时跳过删分支，便于验证 workflow 本身；
  * 已关闭的 issue 跳过，不重复留言；
  * 单项失败只告警不中断（`::warning::`）——清理是收尾动作，失败不应反过来挡住已合并的 PR。

零第三方依赖（标准库 urllib），不依赖 `gh` CLI 是否在 runner 的 PATH 上。
本地可跑 `--dry-run` 只打印计划、不产生任何副作用。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

GITHUB_API = "https://api.github.com"

# 标题里的 `#N`：前后不得是字母数字或 `#`（避免 `123#456`、`##123` 之类的碎片）。
# 上限 6 位是 GitHub issue 编号的量级，不放大以免吃到 commit sha 的片段。
TITLE_REF_RE = re.compile(r"(?<![\w#])#([1-9]\d{0,5})(?![\w])")

# 正文里的**带关键词**引用：`Closes #284` / `Fixes: #123` / `refs #284 #285` / `关闭 #284`。
# 关键词后允许冒号与空白，可连续跟多个编号；中文关键词同样支持（本仓库 CHANGELOG 中英并存）。
#
# 必须带 `#`：GitHub 的跨引用规范就是 `#N`，本仓库标题与 CHANGELOG 也全用这种写法。若允许
# 裸数字，中文正文里的「修复 2026 年的崩溃」「修复 3 个 bug」都会被误判成 issue 编号 —— 那
# 种误判的后果是往无关 issue 里留言，比漏关一个 issue 严重得多，故宁可保守。
CLOSE_RE = re.compile(
    # 词边界：`\b` 在 CJK 前后都是 `\w`，所以「已关闭 #284」这种写法永远匹配不上。
    # 改用「前面不是 `\w` **或** 前面是汉字」，两种情况都放行。
    r"(?i)(?:(?<!\w)|(?<=[\u4e00-\u9fff]))"
    r"(?:closes?|closed|fixes?|fixed|resolves?|resolved|refs?|references?|关闭|解决|修复)"
    r"\s*[:：]?\s*#\s*([1-9]\d{0,5})(?!\d)"
    r"(?:\s*#\s*([1-9]\d{0,5})(?!\d))*"
)

# 跳过删分支的标题标记：验证本 workflow 时会开一个标题带 test 的 PR，合并后不该真删分支。
SKIP_DELETE_MARKERS = ("test", "draft")


def extract_issue_refs(title: str, body: str) -> list[int]:
    """从 PR 标题 + 正文提取应关闭的 issue 编号。

    返回**去重且保持首次出现顺序**的列表：PR 正文一般按主张顺序写（先写主 issue），
    保持这个顺序比数字排序更符合阅读预期。
    """
    refs: list[int] = []
    seen: set[int] = set()

    for n in TITLE_REF_RE.findall((title or "").strip()):
        v = int(n)
        if v not in seen:
            seen.add(v)
            refs.append(v)

    for m in CLOSE_RE.finditer(body or ""):
        vals = [g for g in m.groups() if g is not None]
        for n in vals:
            v = int(n)
            if v not in seen:
                seen.add(v)
                refs.append(v)

    return refs


# --------------------------------------------------------------------------- #
# GitHub API（只读检查 + 删分支 + 关 issue，全部走 GITHUB_TOKEN）
# --------------------------------------------------------------------------- #
def api(method: str, path: str, token: str, *, payload: dict | None = None):
    """请求 GitHub REST API，返回 (status_code, decoded_json_or_None)。

    404 不抛异常（本脚本多处需要区分「不存在」与「真失败」）；网络与超时同理。
    """
    req = urllib.request.Request(
        GITHUB_API + path,
        data=None if payload is None else json.dumps(payload).encode("utf-8"),
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "User-Agent": "taskboard-merge-cleanup",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8", "replace")
            return resp.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            data = json.loads(raw) if raw else None
        except ValueError:
            data = None
        return e.code, data
    except (urllib.error.URLError, TimeoutError, ValueError) as e:
        raise RuntimeError(f"{method} {path} 失败: {e}") from e


def head_branch(repo: str, head_ref: str, token: str) -> tuple[int, str | None]:
    """读取远端源分支，返回 (status, 当前 sha)。

    一次请求同时回答两个问题：分支还在不在（404 vs 200），以及它现在指向哪个 sha
    （与 PR head sha 对比，排除别人在合并后又往该分支推了新提交的情形）。
    此前这里拆成 `ref_exists` + `head_ref_at` 两个函数，对同一端点发了两次 GET。
    """
    status, data = api(
        "GET", f"/repos/{repo}/git/ref/heads/{urllib.parse.quote(head_ref, safe='/')}", token
    )
    return status, ((data or {}).get("object") or {}).get("sha")


def close_issue(
    repo: str, number: int, comment: str, token: str
) -> tuple[str, bool, bool]:
    """关闭 issue 并留言。返回 (state, already_closed, comment_ok)。

    `already_closed=True` 时不做任何写入（不重复留言）。关闭本身失败抛 RuntimeError；
    留言失败不抛 —— issue 已关闭才是本动作的目的，留言只是补充说明。
    """
    status, data = api("GET", f"/repos/{repo}/issues/{number}", token)
    if status == 404:
        raise RuntimeError(f"#{number} 不存在（可能不是本仓库的 issue）")
    if status != 200:
        raise RuntimeError(f"读取 #{number} 失败（HTTP {status}）")
    if (data or {}).get("state", "").lower() == "closed":
        return "closed", True, True
    status, patched = api(
        "PATCH",
        f"/repos/{repo}/issues/{number}",
        token,
        payload={"state": "closed", "state_reason": "completed"},
    )
    if status not in (200, 201):
        raise RuntimeError(f"关闭 #{number} 失败（HTTP {status}）")
    state = (patched or {}).get("state", "closed")
    c_status, _ = api(
        "POST", f"/repos/{repo}/issues/{number}/comments", token, payload={"body": comment}
    )
    return state, False, c_status in (200, 201, 202)


# --------------------------------------------------------------------------- #
# 事件负载：workflow 直接指向 GITHUB_EVENT_PATH，避免多行正文走 shell 变量
# --------------------------------------------------------------------------- #
def load_payload() -> dict:
    path = os.environ.get("GITHUB_EVENT_PATH", "").strip()
    if path:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    raise SystemExit("GITHUB_EVENT_PATH 未设置（本脚本由 workflow 调用；本地验证请传 --body-file/--body-text）")


def event_pr_number(payload: dict, pr_number: str) -> int:
    if pr_number.strip():
        return int(pr_number)
    return int(payload["pull_request"]["number"])


def event_pr_title(payload: dict, pr_title: str) -> str:
    if pr_title.strip():
        return pr_title
    return payload["pull_request"]["title"]


def event_pr_body(payload: dict, body_text: str, body_file: str) -> str:
    if body_file.strip():
        with open(body_file, encoding="utf-8") as f:
            return f.read()
    if body_text.strip():
        return body_text
    return payload["pull_request"]["body"] or ""


def warn(msg: str) -> None:
    print(f"::warning::{msg}")


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #
def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--repo", required=True, help="仓库全名 owner/name")
    p.add_argument("--pr-number", default="", help="PR 编号；留空则从事件负载读取")
    p.add_argument("--pr-title", default="", help="PR 标题；留空则从事件负载读取")
    p.add_argument("--body-text", default="", help="PR 正文（内联）；一般不用，正文走事件负载文件")
    p.add_argument("--body-file", default="", help="PR 正文文件路径（本地验证用）")
    p.add_argument("--base-ref", default="", help="PR 目标分支；留空则从事件负载读取")
    p.add_argument("--head-ref", default="", help="源分支名；留空则从事件负载读取")
    p.add_argument("--head-sha", default="", help="源分支 head 提交 sha；留空则从事件负载读取")
    p.add_argument(
        "--head-repo",
        default="",
        help="源分支所属仓库全名；留空则用 --repo（即只删同仓库分支，fork PR 自动跳过）",
    )
    p.add_argument("--dry-run", action="store_true", help="只打印计划，不执行任何写操作")
    args = p.parse_args(argv)

    token = os.environ.get("GH_TOKEN", "") or os.environ.get("GITHUB_TOKEN", "")
    if not args.dry_run and not token:
        print("::error::GH_TOKEN / GITHUB_TOKEN 未设置，无法执行清理操作", file=sys.stderr)
        return 2

    payload = load_payload()
    pr_number = event_pr_number(payload, args.pr_number)
    pr_title = event_pr_title(payload, args.pr_title)
    pr_body = event_pr_body(payload, args.body_text, args.body_file)
    base_ref = args.base_ref.strip() or payload["pull_request"]["base"]["ref"]
    head_ref = args.head_ref.strip() or payload["pull_request"]["head"]["ref"]
    head_sha = args.head_sha.strip() or payload["pull_request"]["head"]["sha"]
    head_repo = args.head_repo.strip() or args.repo

    pr_url = f"https://github.com/{args.repo}/pull/{pr_number}"
    close_comment = (
        f"由合并后的 PR 自动关闭（{args.repo} · [#{pr_number}]({pr_url})）。\n\n"
        "本 issue 的 PR 已合入，无需再手动收尾。"
    )

    print(
        f"PR #{pr_number} → {base_ref}（head: {head_ref}@{head_sha[:7]}，repo: {head_repo}）\n"
        f"标题: {pr_title or '(空)'}\n"
    )

    # 1) 源分支删除：仅同仓库分支；fork 分支不属于本仓库权限范围，跳过。
    if head_repo != args.repo:
        print(f"跳过删分支：源分支属于 fork（{head_repo}），不是 {args.repo} 的分支")
    else:
        markers = [m for m in SKIP_DELETE_MARKERS if m in (pr_title or "").lower()]
        if markers:
            print(f"跳过删分支：PR 标题含标记 {markers}，保留分支便于验证 workflow 本身")
        elif args.dry_run:
            print(f"[dry-run] 将删除远端分支 {args.repo} → {head_ref}")
        else:
            status, current_sha = head_branch(args.repo, head_ref, token)
            if status != 200:
                print(f"分支 {head_ref} 不存在（可能已删除），跳过")
            elif current_sha != head_sha:
                warn(
                    f"远端 {head_ref} 当前 sha {(current_sha or '')[:7]} 已不是 "
                    f"PR head {head_sha[:7]}，为避免误删保留分支"
                )
            else:
                status, _ = api(
                    "DELETE",
                    f"/repos/{args.repo}/git/ref/heads/{urllib.parse.quote(head_ref, safe='/')}",
                    token,
                )
                if status in (200, 204):
                    print(f"已删除源分支 {head_ref}")
                else:
                    warn(f"删除分支 {head_ref} 失败（HTTP {status}）")

    # 2) 关闭关联 issue：已关闭的原样保留，避免重复留言。
    refs = extract_issue_refs(pr_title, pr_body)
    if not refs:
        print("未从标题 / 正文提取到带关闭语义的 issue 引用，跳过关闭 issue")
        return 0

    print(f"待处理 issue 引用：{[f'#{n}' for n in refs]}")
    failures = 0
    for n in refs:
        if args.dry_run:
            print(f"[dry-run] 将检查并关闭 #{n}（{pr_url}）")
            continue
        try:
            state, _ = api("GET", f"/repos/{args.repo}/issues/{n}", token)
        except RuntimeError as e:
            warn(str(e))
            failures += 1
            continue
        if state == 404:
            warn(f"#{n} 不存在，跳过")
            failures += 1
            continue
        if state == 200:
            try:
                new_state, already_closed, comment_ok = close_issue(args.repo, n, close_comment, token)
            except RuntimeError as e:
                warn(str(e))
                failures += 1
                continue
            if already_closed:
                print(f"#{n} 此前已关闭（state={new_state}），原样保留、未重复留言")
            elif comment_ok:
                print(f"已关闭 #{n}")
            else:
                warn(f"#{n} 已关闭，但留言失败（不影响关闭结果）")
        else:
            warn(f"读取 #{n} 失败（HTTP {state}），跳过")
            failures += 1

    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
