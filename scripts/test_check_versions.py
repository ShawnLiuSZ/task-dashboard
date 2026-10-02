#!/usr/bin/env python3
"""`scripts/check-versions.py` 的单测（Issue #330）。

文件名带连字符，不能直接 `import check-versions` —— 按仓库既有做法用
`importlib.util.spec_from_file_location` 加载（见 `test_merge_cleanup.py`）。

覆盖两层：
* **纯解析函数**：用合成文本验证，能构造出「只有一处漂移」的负例；
* **真实仓库**：`main()` 直接跑一遍，确保当前仓库 5 个文件 + README 中英引用一致
  —— 这是本条 CI 门禁的实际断言，比单测合成用例更贴近线上。
"""

from __future__ import annotations

import importlib.util
import os
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _load():
    spec = importlib.util.spec_from_file_location(
        "check_versions", Path(__file__).with_name("check-versions.py")
    )
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules["check_versions"] = mod
    spec.loader.exec_module(mod)
    return mod


cv = _load()


class TestParsers(unittest.TestCase):
    def test_cargo_toml_reads_package_section_not_dependency(self):
        text = (
            "[package]\n"
            'name = "taskboard"\n'
            'version = "1.2.3"\n'
            "\n"
            "[dependencies]\n"
            'serde = { version = "9.9.9" }\n'
            'other = { version = "8.8.8" }\n'
        )
        self.assertEqual(cv.cargo_toml_version(text), "1.2.3")

    def test_cargo_toml_missing_version_returns_none(self):
        self.assertIsNone(cv.cargo_toml_version("[package]\nname = \"x\"\n"))

    def test_cargo_lock_picks_named_package_not_first_block(self):
        text = (
            "version = 3\n\n"
            "[[package]]\n"
            'name = "aaa"\n'
            'version = "9.9.9"\n\n'
            "[[package]]\n"
            'name = "taskboard"\n'
            'version = "1.2.3"\n\n'
            "[[package]]\n"
            'name = "zzz"\n'
            'version = "7.7.7"\n'
        )
        self.assertEqual(cv.cargo_lock_version(text), "1.2.3")

    def test_cargo_lock_missing_package_returns_none(self):
        self.assertIsNone(cv.cargo_lock_version("[[package]]\nname = \"a\"\nversion = \"1.0.0\"\n"))

    def test_package_lock_reports_both_locations(self):
        text = '{"version": "1.2.3", "packages": {"": {"version": "1.2.3"}}}'
        self.assertEqual(
            cv.package_lock_versions(text),
            [("顶层 version", "1.2.3"), ('packages[""].version', "1.2.3")],
        )

    def test_package_lock_detects_divergent_inner_version(self):
        """负例：只改了顶层 `version`，`packages[""]` 仍是旧值 —— 必须能被看见。"""
        text = '{"version": "1.2.3", "packages": {"": {"version": "0.4.0"}}}'
        values = [v for _, v in cv.package_lock_versions(text)]
        self.assertEqual(values, ["1.2.3", "0.4.0"])
        self.assertEqual(len(set(values)), 2)

    def test_readme_refs_match_current_version_wording_only(self):
        text = (
            "> **⚠️ 更新提醒**：**v0.3.24 及以下版本**不能自动更新。\n"
            "## MCP Server（v0.3.10 新增 · v0.3.12 集成进 app 二进制）\n"
            "- [`docs/CHANGELOG.md`](./docs/CHANGELOG.md) — 各版本记录（v0.3.1 → 最新 v0.6.5）\n"
            "> 版本 v0.6.5 · 本地跨平台桌面 App，2026-09-29\n"
        )
        refs = dict((label, v) for label, v in cv.readme_version_refs(text))
        self.assertEqual(refs["最新版引用"], "0.6.5")
        self.assertEqual(refs["尾注版本"], "0.6.5")
        # 历史叙述（v0.3.24 / v0.3.10 / v0.3.12 / v0.3.1）一律不得被当成「当前版本」。
        self.assertEqual(len(cv.readme_version_refs(text)), 2)

    def test_readme_refs_english_variants(self):
        text = "log (v0.3.1 → latest v0.6.5)\n\n> Version v0.6.5 · Local app, 2026-09-29\n"
        refs = cv.readme_version_refs(text)
        self.assertEqual([v for _, v in refs], ["0.6.5", "0.6.5"])

    def test_strip_tag_prefix(self):
        self.assertEqual(cv.strip_tag_prefix("v0.6.5"), "0.6.5")
        self.assertEqual(cv.strip_tag_prefix("0.6.5"), "0.6.5")
        self.assertEqual(cv.strip_tag_prefix("refs/tags/v0.6.5"), "0.6.5")
        self.assertEqual(cv.strip_tag_prefix("V1.0.0"), "1.0.0")


class TestRealRepository(unittest.TestCase):
    """真实仓库断言：这就是 CI 里跑的那条门禁。"""

    def test_current_repository_is_consistent(self):
        self.assertEqual(cv.main(), 0, "仓库当前版本号不一致，见上方明细")

    def test_all_five_files_report_the_same_version(self):
        read = lambda rel: (ROOT / rel).read_text(encoding="utf-8")  # noqa: E731

        canonical = cv.json_version(read("app/package.json"))
        self.assertEqual(cv.cargo_toml_version(read("app/src-tauri/Cargo.toml")), canonical)
        self.assertEqual(cv.json_version(read("app/src-tauri/tauri.conf.json")), canonical)
        self.assertEqual(cv.cargo_lock_version(read("app/src-tauri/Cargo.lock")), canonical)
        for _, value in cv.package_lock_versions(read("app/package-lock.json")):
            self.assertEqual(value, canonical)

    def test_readmes_reference_the_current_version(self):
        canonical = cv.json_version((ROOT / "app/package.json").read_text(encoding="utf-8"))
        for rel in ("README.md", "README.en.md"):
            refs = cv.readme_version_refs((ROOT / rel).read_text(encoding="utf-8"))
            self.assertTrue(refs, f"{rel} 里没找到「当前版本」字符串")
            for label, value in refs:
                self.assertEqual(value, canonical, f"{rel}（{label}）与 package.json 不一致")

    def test_tag_mismatch_is_reported(self):
        """`GITHUB_REF_NAME` 指向别的版本时必须报错（发版打错 tag 的场景）。"""
        old = os.environ.get("GITHUB_REF_NAME")
        os.environ["GITHUB_REF_NAME"] = "v9.9.9"
        try:
            self.assertEqual(cv.main(), 1)
        finally:
            if old is None:
                os.environ.pop("GITHUB_REF_NAME", None)
            else:
                os.environ["GITHUB_REF_NAME"] = old

    def test_non_semver_ref_is_ignored(self):
        """分支名 / 非 semver 的 ref 不参与比对（PR 上是 `refs/pull/…/merge` 之类）。"""
        old = os.environ.get("GITHUB_REF_NAME")
        os.environ["GITHUB_REF_NAME"] = "develop"
        try:
            self.assertEqual(cv.main(), 0)
        finally:
            if old is None:
                os.environ.pop("GITHUB_REF_NAME", None)
            else:
                os.environ["GITHUB_REF_NAME"] = old


    # ---- #359：Python MCP 的 serverInfo 版本 -------------------------------- #
    # 原先 server.py 硬编码 "0.6.1"（实际 0.6.5）且本脚本不覆盖该文件 ⇒
    # `initialize` 向 agent 报过期版本、漂移无门禁。
    def test_mcp_server_version_is_not_hardcoded(self):
        import check_versions as cv

        src = (cv.ROOT / "mcp_server/server.py").read_text(encoding="utf-8")
        # 已改为单一来源 ⇒ 返回 None（无可比的硬编码值）
        self.assertIsNone(
            cv.mcp_server_version(src),
            "server.py 不应再硬编码 serverInfo 版本，应调用 _app_version()",
        )

    def test_mcp_server_hardcoded_version_is_detected(self):
        import check_versions as cv

        bad = '"serverInfo": {"name": "taskboard", "version": "0.6.1"},'
        self.assertEqual(cv.mcp_server_version(bad), "0.6.1")

    def test_python_mcp_reports_the_current_version(self):
        """server.py 的 _app_version() 必须与 Cargo.toml 一致（单一来源）。"""
        import check_versions as cv

        cargo = cv.cargo_toml_version(
            (cv.ROOT / "app/src-tauri/Cargo.toml").read_text(encoding="utf-8")
        )
        self.assertIsNotNone(cargo)
        sys.path.insert(0, str(cv.ROOT / "mcp_server"))
        try:
            import server as S

            self.assertEqual(S._app_version(), cargo)
        finally:
            sys.path.pop(0)

if __name__ == "__main__":
    unittest.main()
