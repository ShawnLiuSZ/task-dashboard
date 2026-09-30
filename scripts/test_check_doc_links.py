#!/usr/bin/env python3
"""`scripts/check-doc-links.py` 的单测（Issue #330 新增孤岛检测）。

文件名带连字符，用 `importlib.util.spec_from_file_location` 加载（与
`test_merge_cleanup.py` / `test_check_versions.py` 同款）。

覆盖：
* `is_kb_doc` —— 哪些路径算「知识库文档」；
* `find_orphans` —— 孤岛判定（#330 新增的核心逻辑）；
* `mask_code` —— 代码块 / 行内代码屏蔽（既有行为，防回归）；
* 真实仓库 —— `main()` 必须返回 0（CI 里跑的就是这条）。
"""

from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _load():
    spec = importlib.util.spec_from_file_location(
        "check_doc_links", Path(__file__).with_name("check-doc-links.py")
    )
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules["check_doc_links"] = mod
    spec.loader.exec_module(mod)
    return mod


cdl = _load()

README = "README.md"
CHANGELOG = "docs/CHANGELOG.md"
INDEX = (README, "README.en.md", CHANGELOG, "docs/CHANGELOG.en.md")


class TestIsKbDoc(unittest.TestCase):
    def test_direct_children_of_docs_are_kb_docs(self):
        self.assertTrue(cdl.is_kb_doc("docs/issue-216-del-last-account.md"))
        self.assertTrue(cdl.is_kb_doc("docs/CHANGELOG.md"))

    def test_non_docs_paths_are_not_kb_docs(self):
        self.assertFalse(cdl.is_kb_doc("README.md"))
        self.assertFalse(cdl.is_kb_doc("AGENTS.md"))
        self.assertFalse(cdl.is_kb_doc("app/src/README.md"))
        self.assertFalse(cdl.is_kb_doc("docs/sub/nested.md"))
        self.assertFalse(cdl.is_kb_doc("docs/notes.txt"))


class TestFindOrphans(unittest.TestCase):
    def test_doc_referenced_by_readme_is_not_orphan(self):
        inbound = {"docs/a.md": {"README.md"}}
        self.assertEqual(cdl.find_orphans(["docs/a.md"], inbound), [])

    def test_doc_referenced_by_changelog_is_not_orphan(self):
        inbound = {"docs/a.md": {"docs/CHANGELOG.md"}}
        self.assertEqual(cdl.find_orphans(["docs/a.md"], inbound), [])

    def test_doc_referenced_only_by_another_doc_is_orphan(self):
        """#330 的真实形态：`v0.3.16-multi-account.md` 只被 `v0.3.15-pat-auth.md` 引用。"""
        inbound = {"docs/a.md": {"docs/v0.3.15-pat-auth.md"}}
        self.assertEqual(
            cdl.find_orphans(["docs/a.md"], inbound),
            [("docs/a.md", ["docs/v0.3.15-pat-auth.md"])],
        )

    def test_unreferenced_doc_is_orphan(self):
        self.assertEqual(cdl.find_orphans(["docs/a.md"], {}), [("docs/a.md", [])])

    def test_multiple_sources_are_sorted_and_index_wins(self):
        inbound = {"docs/a.md": {"docs/z.md", "README.md", "AGENTS.md"}}
        # 只要命中索引文件就不算孤岛
        self.assertEqual(cdl.find_orphans(["docs/a.md"], inbound, INDEX), [])

    def test_index_membership_is_what_matters(self):
        inbound = {"docs/a.md": {"docs/z.md", "AGENTS.md"}}
        rel, others = cdl.find_orphans(["docs/a.md"], inbound, INDEX)[0]
        self.assertEqual(rel, "docs/a.md")
        # 非索引来源按字典序返回，便于稳定输出
        self.assertEqual(others, ["AGENTS.md", "docs/z.md"])

    def test_empty_input_returns_empty(self):
        self.assertEqual(cdl.find_orphans([], {}), [])


class TestMaskCode(unittest.TestCase):
    def test_fenced_block_is_masked_but_line_count_preserved(self):
        text = "before\n```\n](broken.md)\n```\nafter\n"
        masked = cdl.mask_code(text)
        self.assertNotIn("broken.md", masked)
        # 行数保持不变（行号锚点/定位依赖这个不变式）
        self.assertEqual(masked.count("\n"), text.count("\n"))

    def test_inline_code_is_masked(self):
        masked = cdl.mask_code("示例：`](app/...)` 这样写")
        self.assertNotIn("](app/...)", masked)

    def test_plain_link_survives_masking(self):
        masked = cdl.mask_code("- [`docs/a.md`](./docs/a.md) 说明")
        self.assertIn("](./docs/a.md)", masked)


class TestRealRepository(unittest.TestCase):
    def test_repository_passes_all_checks(self):
        self.assertEqual(cdl.main(), 0, "文档链接 / 孤岛检测未通过，见上方明细")

    def test_every_kb_doc_is_indexed(self):
        """直接断言「无孤岛」，比只看 main() 返回码更明确地锁住 #330 的修复。"""
        files = cdl.iter_markdown()
        inbound: dict[str, set[str]] = {}
        for path in files:
            text = cdl.mask_code(path.read_text(encoding="utf-8", errors="replace"))
            rel = str(path.relative_to(cdl.ROOT))
            for m in cdl.LINK_RE.finditer(text):
                target = m.group(1) or m.group(2)
                if not target or target.startswith(cdl.EXTERNAL_PREFIXES) or target.startswith("#"):
                    continue
                if "file://" in target:
                    continue
                part = target.split("#", 1)[0].split("?", 1)[0]
                if not part:
                    continue
                resolved = (path.parent / part).resolve()
                try:
                    inbound.setdefault(str(resolved.relative_to(cdl.ROOT)), set()).add(rel)
                except ValueError:
                    continue

        docs_rels = [str(p.relative_to(cdl.ROOT)) for p in files if cdl.is_kb_doc(str(p.relative_to(cdl.ROOT)))]
        self.assertGreater(len(docs_rels), 50, "知识库文档数量异常，检查 is_kb_doc 是否失效")
        orphans = cdl.find_orphans(docs_rels, inbound)
        self.assertEqual(orphans, [], f"存在孤岛文档：{orphans}")


if __name__ == "__main__":
    unittest.main()
