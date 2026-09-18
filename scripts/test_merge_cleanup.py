#!/usr/bin/env python3
"""scripts/merge-cleanup.py 的单测。

分两层：

  1. `extract_issue_refs` 的纯逻辑 —— 这里锁住的是**误关 issue**的防线：正则一旦放宽，
     PR 正文里引用的历史 issue 号（CHANGELOG 里的「沿用 #155 / #175 / #237 的教训」）就
     会被当成要关闭的目标，往早已关闭的无关 issue 里留言。这类缺陷 CI 测不到，只能靠
     数据驱动的用例兜住。反向验证：把 CLOSE_RE 放宽成裸 `#N` 匹配，
     `test_body_bare_ref_ignored` 等用例会失败。
  2. dry-run 走完整 `main()` —— 覆盖 argparse 属性名、事件负载读取、fork / 标记 / 无引用
     等分支。干跑全程不打网络，所以不需要 mock。

GitHub API 的真实读写（删分支 / 关 issue）仍不在单测范围 —— 与 mcp_server/test_server.py
的取舍一致。

运行：python3 -m unittest discover -s scripts -p 'test_*.py'
"""

import contextlib
import importlib.util
import io
import json
import os
import tempfile
import unittest
from pathlib import Path


def _load(name, filename):
    """按文件名加载带连字符的模块（`merge-cleanup.py` 不是合法的 import 标识符）。"""
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


merge_cleanup = _load("merge_cleanup", "merge-cleanup.py")
extract_issue_refs = merge_cleanup.extract_issue_refs


class ExtractIssueRefsTest(unittest.TestCase):
    def test_title_hash_ref(self):
        self.assertEqual(extract_issue_refs("feat(ci): 合并后自动收尾 (#284)", ""), [284])

    def test_title_parenthetical_ref_only(self):
        # 标题里通常只有 `(#N)` 这一处主旨引用。
        self.assertEqual(extract_issue_refs("fix: 详情关联 (#278)", "正文不写编号"), [278])

    def test_body_keyword_ref(self):
        self.assertEqual(extract_issue_refs("t", "Closes #284"), [284])

    def test_keyword_with_colon(self):
        self.assertEqual(extract_issue_refs("t", "Fixes: #123"), [123])

    def test_case_insensitive_and_extra_whitespace(self):
        self.assertEqual(extract_issue_refs("t", "REFS  #42"), [42])

    def test_chinese_keywords(self):
        self.assertEqual(extract_issue_refs("t", "关闭 #284\n解决 #285"), [284, 285])

    def test_chinese_keyword_after_cjk_prefix(self):
        # 回归：`\b` 在两个汉字之间不构成词边界（汉字都是 `\w`），
        # 「已关闭 #284」「本次解决 #285」这类「汉字 + 关键词 + #N」的写法永远匹配不上。
        self.assertEqual(extract_issue_refs("t", "已关闭 #284"), [284])
        self.assertEqual(extract_issue_refs("t", "本次解决 #285"), [285])

    def test_keyword_with_trailing_particle_not_matched(self):
        # 关键词与 `#N` 之间隔了「了 / 过」等助词时**不**匹配 —— 这是有意的：
        # 「本次修复了 #284 的问题」通常是回顾性叙述，不是关闭声明；GitHub 自身也只识别
        # 行首的固定英文关键词。宁可漏关（人工补），不猜语义去关。
        self.assertEqual(extract_issue_refs("t", "本次修复了 #284 的问题"), [])
        self.assertEqual(extract_issue_refs("t", "已解决过 #284"), [])

    def test_keyword_must_not_match_as_substring(self):
        # 反向验证词边界：关键词不能被当成单词碎片匹配（否则 `prefixfixed #5` 会误关）。
        self.assertEqual(extract_issue_refs("t", "prefixfixed #5"), [])
        self.assertEqual(extract_issue_refs("t", "notresolved #5"), [])

    def test_multiple_refs_after_one_keyword(self):
        self.assertEqual(extract_issue_refs("t", "Closes #1 #2"), [1, 2])

    def test_multiple_keywords(self):
        body = "Closes #1\nFixes #2\nResolves #3"
        self.assertEqual(extract_issue_refs("t", body), [1, 2, 3])

    def test_title_takes_priority_over_body(self):
        # 去重且保持首次出现顺序：标题先出现就排前面。
        self.assertEqual(extract_issue_refs("feat: x (#284)", "Closes #284\nFixes #285"), [284, 285])

    def test_first_occurrence_order_is_kept(self):
        self.assertEqual(extract_issue_refs("t", "Fixes #2\nCloses #1"), [2, 1])

    def test_body_bare_ref_ignored(self):
        # 本仓库 PR 正文习惯引用历史 issue 号 —— 裸 `#N` 绝不能当成要关闭的目标。
        self.assertEqual(extract_issue_refs("t", "沿用 #155 / #175 / #237 的迁移教训"), [])

    def test_realistic_pr_body_only_closes_declared_issue(self):
        # 复刻一次真实 PR 正文：含 PR 号、commit sha、文档路径、CHANGELOG 里的历史 issue
        # 引用。只有头部的 `Refs #284` 应该被提取。
        body = """## 关联
Refs #284 — PR 合并后自动收尾

## 做了什么
- 新增 `.github/workflows/merge-cleanup.yml`
- 新增 `scripts/merge-cleanup.py`

## 验证
- `cargo test` 135 通过 / `b046fe62b9aa52e6` 是上一个合并 commit
- 详见 PR #282 与 docs/issue-237-card-creator-row.md
- 迁移教训参见 #155 / #175 / #237（均已关闭）
"""
        self.assertEqual(extract_issue_refs("feat(ci): 合并后自动收尾 (#284)", body), [284])

    def test_non_keyword_number_not_closed(self):
        # 中文正文里「修复 N 个 bug」「2026 年」不是 issue 编号；PR 号也不该被关。
        body = "修复 2026 年的崩溃\n修掉 3 个 bug\n参考 PR #777\n关闭词后面没有 # 也不算"
        self.assertEqual(extract_issue_refs("t", body), [])

    def test_keyword_without_hash_not_closed(self):
        # 要求带 `#` 是有意的取舍（见 CLOSE_RE 注释）：否则「修复 3 个 bug」会误关 #3。
        self.assertEqual(extract_issue_refs("t", "Fixes 3 bugs"), [])

    def test_oversized_number_ignored(self):
        # 超过 6 位的不算 issue 编号（避免吃到 sha 或时间戳片段）。
        self.assertEqual(extract_issue_refs("t", "Closes #1234567"), [])
        self.assertEqual(extract_issue_refs("t", "Closes #0123"), [])

    def test_title_ignores_sha_and_ref_path(self):
        # 标题里的 sha / ref 路径碎片不应被当成 issue。
        title = "fix: v1.2.3 refs/heads/feature/issue-284-xxx abc1234 deadbeef"
        self.assertEqual(extract_issue_refs(title, ""), [])

    def test_zero_and_leading_zero_ignored(self):
        self.assertEqual(extract_issue_refs("t", "Closes #0"), [])
        self.assertEqual(extract_issue_refs("t", "Closes #007"), [])

    def test_empty_inputs(self):
        self.assertEqual(extract_issue_refs("", ""), [])

    def test_dedup_across_title_and_body(self):
        self.assertEqual(extract_issue_refs("x (#5)", "Closes #5 #5"), [5])

    def test_marker_lists_are_the_documented_ones(self):
        # 标题含这些标记时跳过删分支 —— 改这里意味着改 workflow 的验证方式，必须显式。
        self.assertEqual(merge_cleanup.SKIP_DELETE_MARKERS, ("test", "draft"))


class DryRunFlowTest(unittest.TestCase):
    """dry-run 走完整 `main()`：覆盖 argparse 属性名、事件负载读取、分支 / issue 判定。

    回归：`args.dry-run` 会被 Python 解析成 `args.dry - run`（argparse 把连字符转成下划线
    存属性），AttributeError 只在 dry-run 分支才触发。上面的用例只覆盖
    `extract_issue_refs` 这一条纯函数路径，那个错误因此在本地测不出来，只有真实 PR 合并
    后 workflow 跑起来才会暴露 —— 而那时 PR 已经合进 develop 了。

    dry-run 全程不打网络（删分支与关 issue 的写操作都先判定 dry_run），所以这里不需要
    任何 mock，也符合本仓库「单测不打真网络」的约定。
    """

    BASE_PR = {
        "number": 285,
        "title": "feat(ci): 合并后自动收尾 (#284)",
        "body": "Refs #284\n\n沿用 #155 / #175 的迁移教训",
        "base": {"ref": "develop"},
        "head": {"ref": "feature/issue-284-x", "sha": "abcdef1234567890"},
    }

    def _run(self, pr=None, extra=()):
        payload = {"pull_request": pr or self.BASE_PR}
        old = os.environ.get("GITHUB_EVENT_PATH")
        fd, path = tempfile.mkstemp(suffix=".json")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(payload, f)
        os.environ["GITHUB_EVENT_PATH"] = path
        buf = io.StringIO()
        try:
            with contextlib.redirect_stdout(buf):
                code = merge_cleanup.main(["--repo", "ShawnLiuSZ/task-dashboard", "--dry-run", *extra])
        finally:
            os.unlink(path)
            if old is None:
                os.environ.pop("GITHUB_EVENT_PATH", None)
            else:
                os.environ["GITHUB_EVENT_PATH"] = old
        return code, buf.getvalue()

    def test_dry_run_deletes_branch_and_closes_ref(self):
        code, out = self._run()
        self.assertEqual(code, 0)
        self.assertIn("[dry-run] 将删除远端分支", out)
        self.assertIn("[dry-run] 将检查并关闭 #284", out)
        # 正文里裸引用的历史 issue 绝不该进入待处理列表
        self.assertNotIn("#155", out.split("待处理 issue 引用：")[1])

    def test_dry_run_fork_skips_delete(self):
        code, out = self._run(
            extra=("--head-repo", "forkuser/task-dashboard"),
        )
        self.assertEqual(code, 0)
        self.assertIn("源分支属于 fork", out)
        self.assertNotIn("[dry-run] 将删除远端分支", out)
        # 关 issue 与删分支相互独立：fork PR 依然要关 issue
        self.assertIn("[dry-run] 将检查并关闭 #284", out)

    def test_dry_run_test_marker_skips_delete(self):
        pr = {**self.BASE_PR, "title": "test: workflow 验证 (#284)"}
        code, out = self._run(pr=pr)
        self.assertEqual(code, 0)
        self.assertIn("PR 标题含标记 ['test']", out)
        self.assertNotIn("[dry-run] 将删除远端分支", out)

    def test_dry_run_draft_marker_skips_delete(self):
        pr = {**self.BASE_PR, "title": "Draft: 合并后自动收尾 (#284)"}
        code, out = self._run(pr=pr)
        self.assertEqual(code, 0)
        self.assertIn("PR 标题含标记 ['draft']", out)

    def test_dry_run_without_closing_ref_skips_issue(self):
        pr = {**self.BASE_PR, "title": "chore: 更新依赖", "body": "沿用 #155 的教训"}
        code, out = self._run(pr=pr)
        self.assertEqual(code, 0)
        self.assertIn("未从标题 / 正文提取到带关闭语义的 issue 引用", out)

    def test_dry_run_slashed_branch_name_is_quoted_path(self):
        # head_ref 含 `/`（feature/issue-284-x）：URL 编码在 api() 里做，这里只确认
        # 正常路径不因分支名形态而报错。
        code, out = self._run()
        self.assertEqual(code, 0)
        self.assertIn("feature/issue-284-x", out)


if __name__ == "__main__":
    unittest.main()
