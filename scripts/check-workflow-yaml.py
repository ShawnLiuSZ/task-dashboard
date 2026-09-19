#!/usr/bin/env python3
"""GitHub Actions workflow 静态校验（Issue #284）。

此前 CI 只跑 i18n / MCP 列名 / 文档链接，**没有任何检查会碰 `.github/workflows/`** ——
workflow 的缩进、`on:` 触发条件、权限块写错了，只有在有人真的合并 / 打 tag 时才暴露，
而且往往已经在静默状态里失败。本脚本补上那层防回归。

零第三方依赖：不用 PyYAML（GitHub runner 与本机都不一定装了它），而是做**逐行结构校验**。
这故意不去还原整棵 YAML AST —— workflow 语法里有一批 GitHub 专有写法（`${{ }}` 表达式、
`on:` 被 YAML 1.1 解析成布尔值、多行 `run: |` 块），通用解析器反而更容易误报。校验的是
「历史上真的会咬人的那几类缺陷」：

  1. tab 缩进 / 结构行缩进不是偶数 / 同一作用域内重复 key（YAML 解析失败或静默覆盖）
  2. 缺 `name:` / `on:` / `jobs:`，或 `on:` 下没有任何触发事件
  3. job 既没有 `runs-on:` 也没有 `uses:`（不会执行 / 配置不完整）
  4. step 既没有 `uses:` 也没有 `run:`（空步骤）
  5. 引用的第三方 action 没有固定版本（`actions/checkout` 没有 `@v5` → 随时被上游改坏）
  6. `${{ " ... "` / `${{ ' ... '` —— 表达式里的引号与 YAML 标量引号撞车，job 静默不执行
  7. `if:` 写成含 `: ` 的裸标量（YAML 会把 `github.event.x.y: v` 当复合值解析失败）
  8. 声明了 `permissions:` 却没有任何 scope（等于没配，退回仓库默认权限）
  9. workflow 直接执行仓库内脚本（`run:` 引用 `scripts/`）却没有 `actions/checkout` ——
     runner 的 workspace 默认是空的，不 checkout 会以「file not found」在静默状态失败

本脚本自身的正确性由 `scripts/test_workflow_yaml.py` 兜住：它用合成用例验证「坏的
workflow 一定会被标记」，并用仓库里现存的 workflow 做正向回归验证 —— 一个误报就会让
每个 PR 的 CI 都红，所以这个检查器不能有自己的误报。
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

WORKFLOWS_DIR = Path(__file__).resolve().parent.parent / ".github" / "workflows"

KEY_RE = re.compile(r"^[A-Za-z0-9_\-]+$")
# 列表项：`- key: value`。步骤的起始行（`- uses:` / `- run:` / `- name:`）与
# `strategy.matrix.include` 的条目（`- platform: macos-latest`）都走这里。
ITEM_RE = re.compile(r"^\s*-\s+(?P<key>[A-Za-z0-9_\-]+)\s*:(?P<rest>.*)$")
# 两种写法都要覆盖：步骤内联的 `- uses: X`（本仓库多数 workflow 用这种）与 step 子键的
# `uses: X`。漏掉列表项形式，`- uses: actions/checkout`（无 @v5）这类缺陷就拦不住。
USE_RE = re.compile(r"^\s*(?:-\s+)?uses:\s*(?P<val>\S+)")
# `permissions:` 下合法的 scope 声明：`contents: write`
SCOPE_RE = re.compile(r"^[A-Za-z0-9_\-]+\s*:\s*(?:read|write|none)\s*$")
# `${{ "..." }}` / `${{ '...' }}`：表达式起始处紧跟引号，YAML 标量会先被引号截断。
BAD_EXPR_QUOTE_RE = re.compile(r"\$\{\{\s*[\"']")
BLOCK_INDICATORS = ("|", ">", "|-", ">-", "|+", ">+")
# 第三方 action 需要固定版本；本地 action 与 Docker action 不适用。
LOCAL_USE_PREFIXES = ("./", "../", "docker://")
# 结构缩进：workflow 的层级是固定的（顶层 0 / job 名 2 / job 键 4 / step 项 6 / step 键 8）
JOB_KEY_INDENT = 4
STEP_KEY_INDENT = 8
STEP_ITEM_INDENT = 6


@dataclass
class Step:
    """一个 step。只有同时缺 `uses:` 与 `run:` 才是问题。"""

    line: int
    has_uses: bool = False
    has_run: bool = False

    @property
    def empty(self) -> bool:
        return not self.has_uses and not self.has_run


@dataclass
class Job:
    name: str
    line: int
    keys: dict[str, int] = field(default_factory=dict)  # key -> 首次出现的行号
    has_runs_on: bool = False
    has_uses: bool = False
    steps: list[Step] = field(default_factory=list)


def strip_comment(line: str) -> str:
    """去掉行尾注释，但不碰 `${{ }}` 表达式里的 `#`。

    workflow 里 `run: gh issue close #123` 这种裸 `#` 后面跟注释很常见；这里采取保守策略：
    只在 `#` 前是空白且不在 `${{ }}` 内部时截断。表达式内部整体跳过（避免误删 `#1`）。
    """
    out: list[str] = []
    i = 0
    depth = 0
    while i < len(line):
        if line[i : i + 3] == "${{":
            depth += 1
            out.append("${{")
            i += 3
            continue
        if depth and line[i : i + 2] == "}}":
            depth -= 1
            out.append("}}")
            i += 2
            continue
        if depth == 0 and line[i] == "#" and (i == 0 or line[i - 1] in " \t"):
            break
        out.append(line[i])
        i += 1
    return "".join(out).rstrip()


def indent_of(line: str) -> int:
    return len(line) - len(line.lstrip(" "))


def parse_kv(stripped: str) -> tuple[str, str] | None:
    """把 `key: value` 拆成 (key, value)；不是合法的 key/value 行返回 None。

    必须用 `partition` 而不是 `s[len(key):]` —— 后者会把冒号本身留在 value 里，导致
    `if: >-` 的 value 变成 `": >-"`，块标量 / 空值 / 步骤检测全部失效。
    """
    if ":" not in stripped:
        return None
    key, _, rest = stripped.partition(":")
    key = key.strip()
    if not key or not KEY_RE.fullmatch(key):
        return None
    return key, rest.strip()


def scan(lines: list[str]) -> list[str]:
    """返回该文件的问题列表（空列表 = 通过）。"""
    errors: list[str] = []
    top_keys: list[str] = []
    section: str | None = None
    on_triggers: list[int] = []
    perm_scopes: list[int] = []
    jobs: list[Job] = []
    job: Job | None = None
    step: Step | None = None
    in_block = False
    block_indent = -1
    block_owner: str | None = None  # 块标量所属的 key（用于判定 `run: |` 里的 scripts 引用）
    runs_scripts = False

    def flush_step() -> None:
        nonlocal step
        if step is not None and step.empty:
            errors.append(f"L{step.line}: step 既没有 `uses:` 也没有 `run:`（空步骤不会执行任何动作）")
        step = None

    for ln, raw in enumerate(lines, 1):
        if "\t" in raw:
            errors.append(f"L{ln}: 使用 tab 缩进（YAML 只接受空格）")
            continue
        body = strip_comment(raw.rstrip("\n"))
        if not body.strip():
            continue
        ind = indent_of(body)

        # 块标量内部是自由文本（`if: >-` 的续行常故意用非偶数缩进做视觉对齐），
        # 只做结构解析、不做缩进与 key/value 校验。
        if in_block:
            if ind > block_indent:
                if block_owner == "run" and "scripts/" in body:
                    runs_scripts = True
                continue
            in_block = False
            block_owner = None

        if ind % 2:
            errors.append(f"L{ln}: 缩进 {ind} 不是偶数（workflow 约定统一 2 空格缩进）")

        s = body.strip()

        # 通用检查：表达式里的引号冲突（任何位置都可能是问题）
        if BAD_EXPR_QUOTE_RE.search(body):
            errors.append(
                f"L{ln}: `${{ }}` 表达式里出现了与 YAML 引号冲突的引号，"
                f"job 可能在静默状态被跳过（用单引号包裹整个表达式或转义）"
            )

        # 第三方 action 版本固定
        m = USE_RE.match(body)
        if m:
            val = m.group("val").strip()
            if not val.startswith(LOCAL_USE_PREFIXES):
                if "@" not in val:
                    errors.append(f"L{ln}: 第三方 action `{val}` 未固定版本（应写 @v5 之类）")

        # 列表项
        if s.startswith("- "):
            im = ITEM_RE.match(body)
            if not im:
                errors.append(f"L{ln}: 列表项不是合法的 `- key: value` 形式")
                continue
            if job is not None and ind == STEP_ITEM_INDENT:
                flush_step()
                step = Step(line=ln)
                if im.group("key") == "uses":
                    step.has_uses = True
                elif im.group("key") == "run":
                    step.has_run = True
            # 其它缩进的列表项（`strategy.matrix.include` 等）不做进一步结构校验
            continue

        kv = parse_kv(s)
        if kv is None:
            errors.append(f"L{ln}: 不是合法的 `key: value` 行")
            continue
        key, rest = kv

        # 块标量起始：`run: |` / `if: >-` / `run: >`。
        # 注意这里**不** flush_step：`- name: X` 之后再写 `run: |` 时 step 还没被标记，
        # 先 flush 会把一个有 `run` 的步骤误判成空步骤。
        if rest in BLOCK_INDICATORS:
            in_block, block_indent, block_owner = True, ind, key
            if key == "run" and step is not None:
                step.has_run = True
            continue

        if key == "run" and "scripts/" in rest:
            runs_scripts = True
        if key == "if" and rest and (": " in rest or rest.endswith(":")):
            errors.append(f"L{ln}: `if:` 表达式含 `: ` 但未加引号，YAML 会把它当复合值解析失败")

        # 顶层结构
        if ind == 0:
            top_keys.append(key)
            section = key
            flush_step()
            job = None
            continue

        if section == "on":
            if ind == 2 and rest == "":
                on_triggers.append(ln)
        elif section == "permissions":
            if ind == 2:
                if rest == "":
                    errors.append(f"L{ln}: `permissions:` 下的 `{key}` 缺少 read/write/none")
                elif SCOPE_RE.match(s):
                    perm_scopes.append(ln)
                else:
                    errors.append(f"L{ln}: `permissions:` 下 `{s}` 不是合法的 scope 声明")
        elif section == "jobs":
            if ind == 2:
                flush_step()
                if rest != "":
                    errors.append(f"L{ln}: job `{key}` 必须在单独一行声明（不能 `key: value`）")
                    continue
                job = Job(name=key, line=ln)
                jobs.append(job)
            elif job is None:
                errors.append(f"L{ln}: `jobs:` 下出现不归属于任何 job 的内容")
            elif ind == JOB_KEY_INDENT:
                if key in job.keys:
                    errors.append(
                        f"L{ln}: job `{job.name}` 里 `{key}:` 与 L{job.keys[key]} 重复（后者会静默覆盖）"
                    )
                job.keys[key] = ln
                if key == "runs-on":
                    job.has_runs_on = True
                elif key == "uses":
                    job.has_uses = True
                elif key == "steps":
                    if rest != "":
                        errors.append(f"L{ln}: `steps:` 必须在单独一行声明")
                        continue
                    flush_step()
            elif ind == STEP_KEY_INDENT and step is not None:
                # step 的子键（`uses:` / `run:` / `with:` / `env:` 等）
                if key == "uses":
                    step.has_uses = True
                elif key == "run":
                    step.has_run = True
                continue
        elif section == "env" and ind == 2 and rest == "":
            errors.append(f"L{ln}: `env:` 下的 `{key}` 缺少值")

    flush_step()

    # --- 整体结构检查 ------------------------------------------------- #
    for name in ("name", "on", "jobs"):
        if name not in top_keys:
            errors.append(f"缺少顶层 `{name}:`")
    if top_keys.count("jobs") > 1:
        errors.append("`jobs:` 重复声明")
    if "on" in top_keys and not on_triggers:
        errors.append("`on:` 下没有任何触发事件（workflow 永远不会被触发）")
    if "permissions" in top_keys and not perm_scopes:
        errors.append("`permissions:` 下没有任何 scope 声明（等于没配，退回仓库默认权限）")
    if not jobs:
        errors.append("`jobs:` 下没有任何 job")
    else:
        for j in jobs:
            if not j.has_runs_on and not j.has_uses:
                errors.append(
                    f"L{j.line}: job `{j.name}` 缺少 `runs-on:`（也没有可复用的 `uses:`），不会执行"
                )

    # workflow 直接跑仓库内脚本却没有 checkout：runner 的 workspace 默认是空的，
    # 不 checkout 会以「file not found」在静默状态失败。
    if runs_scripts and "actions/checkout@" not in "\n".join(lines):
        errors.append(
            "有 step 直接执行仓库内脚本，但缺少 `actions/checkout@*`（runner workspace 默认是空的）"
        )

    return errors


def main(argv: list[str] | None = None) -> int:
    if not WORKFLOWS_DIR.is_dir():
        print(f"::error::未找到 {WORKFLOWS_DIR}")
        return 1

    files = sorted(WORKFLOWS_DIR.glob("*.yml")) + sorted(WORKFLOWS_DIR.glob("*.yaml"))
    if not files:
        print(f"::error::{WORKFLOWS_DIR} 下没有任何 workflow 文件")
        return 1

    total_errors = 0
    for path in files:
        lines = path.read_text(encoding="utf-8").splitlines()
        errors = scan(lines)
        if errors:
            total_errors += len(errors)
            rel = path.relative_to(WORKFLOWS_DIR.parent.parent)
            print(f"::error::file={rel}:{path.name} 有 {len(errors)} 个问题:")
            for e in errors:
                print(f"  - {e}")
        else:
            print(f"✓ {path.name}（{len(lines)} 行）")

    if total_errors:
        print(f"::error::共 {total_errors} 个问题")
        return 1
    print(f"✓ workflow 配置校验通过：{len(files)} 个文件")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
