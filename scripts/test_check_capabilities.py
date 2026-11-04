#!/usr/bin/env python3
"""`check-capabilities.py` 的单测。

⚠️ **判别力要求**：每个用例都必须能**真的失败** ⇒ 除了「正常通过」，还要有
「把权限删掉 ⇒ 校验必须报错」的**反向验证**用例（否则测试恒真）。
"""

from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# 以文件路径加载被测脚本（scripts/ 不是包）。
_spec = importlib.util.spec_from_file_location(
    "check_capabilities", ROOT / "scripts" / "check-capabilities.py"
)
assert _spec and _spec.loader
check_capabilities = importlib.util.module_from_spec(_spec)
sys.modules["check_capabilities"] = check_capabilities
_spec.loader.exec_module(check_capabilities)


class CheckCapabilitiesTest(unittest.TestCase):
    """构造临时的 tauri.conf.json + capabilities 目录，跑纯函数 `check()`。"""

    # 假的 ACL manifest：只含本测试用到的两个权限 ⇒ 拼错的标识会被抓住。
    FAKE_MANIFEST = {
        "core:window": {
            "permissions": {
                "allow-start-dragging": {},
                "allow-internal-toggle-maximize": {},
            }
        }
    }

    def _run(self, windows: list[dict], caps: list[dict], manifest: dict | None = None) -> list[str]:
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            (tmp / "app" / "src-tauri" / "capabilities").mkdir(parents=True)
            (tmp / "app" / "src-tauri" / "gen" / "schemas").mkdir(parents=True)
            (tmp / "app" / "src-tauri" / "tauri.conf.json").write_text(
                json.dumps({"app": {"windows": windows}}), encoding="utf-8"
            )
            # ⚠️ manifest 必须存在，否则「拼错标识」那条校验会被整体跳过 ⇒ 用例恒真。
            (tmp / "app" / "src-tauri" / "gen" / "schemas" / "acl-manifests.json").write_text(
                json.dumps(self.FAKE_MANIFEST if manifest is None else manifest),
                encoding="utf-8",
            )
            for i, c in enumerate(caps):
                (tmp / "app" / "src-tauri" / "capabilities" / f"c{i}.json").write_text(
                    json.dumps(c), encoding="utf-8"
                )
            old_root = check_capabilities.ROOT
            old_conf = check_capabilities.TAURI_CONF
            old_cap = check_capabilities.CAP_DIR
            old_manifest = check_capabilities.MANIFEST
            try:
                check_capabilities.ROOT = tmp
                check_capabilities.TAURI_CONF = tmp / "app" / "src-tauri" / "tauri.conf.json"
                check_capabilities.CAP_DIR = tmp / "app" / "src-tauri" / "capabilities"
                check_capabilities.MANIFEST = (
                    tmp / "app" / "src-tauri" / "gen" / "schemas" / "acl-manifests.json"
                )
                return check_capabilities.check()
            finally:
                check_capabilities.ROOT = old_root
                check_capabilities.TAURI_CONF = old_conf
                check_capabilities.CAP_DIR = old_cap
                check_capabilities.MANIFEST = old_manifest

    def test_repo_current_state_passes(self):
        """仓库现状必须通过（否则 CI 会红）。"""
        self.assertEqual(check_capabilities.check(), [])

    def test_overlay_window_without_drag_permission_is_rejected(self):
        """⚠️ 反向验证：删掉 `allow-start-dragging` ⇒ 必须报错。

        这正是 #533 的缺陷形态（Overlay 窗口 + 漏授权 ⇒ 窗口拖不动）。
        """
        problems = self._run(
            windows=[{"label": "main", "titleBarStyle": "Overlay"}],
            caps=[{"identifier": "default", "windows": ["main"], "permissions": ["core:default"]}],
        )
        self.assertTrue(problems, "缺 start-dragging 时必须报错")
        self.assertIn("start-dragging", problems[0])
        self.assertIn("拖不动", problems[0])

    def test_overlay_window_with_drag_permission_passes(self):
        problems = self._run(
            windows=[{"label": "main", "titleBarStyle": "Overlay"}],
            caps=[
                {
                    "identifier": "default",
                    "windows": ["main"],
                    "permissions": ["core:default", "core:window:allow-start-dragging"],
                }
            ],
        )
        self.assertEqual(problems, [])

    def test_glob_windows_pattern_counts_as_granted(self):
        """capability 的 `windows` 支持 glob ⇒ `task-detail-*` 也算覆盖。"""
        problems = self._run(
            windows=[{"label": "task-detail-5-a-1", "titleBarStyle": "Overlay"}],
            caps=[
                {
                    "identifier": "detail",
                    "windows": ["task-detail-*"],
                    "permissions": ["core:window:allow-start-dragging"],
                }
            ],
        )
        self.assertEqual(problems, [])

    def test_permission_on_other_window_does_not_grant(self):
        """⚠️ 权限给了**别的**窗口 ⇒ 不算覆盖（否则会漏检）。"""
        problems = self._run(
            windows=[{"label": "main", "titleBarStyle": "Overlay"}],
            caps=[
                {
                    "identifier": "other",
                    "windows": ["about"],
                    "permissions": ["core:window:allow-start-dragging"],
                }
            ],
        )
        self.assertTrue(problems, "权限给了别的窗口时必须报错")

    def test_non_overlay_window_needs_no_drag_permission(self):
        """普通窗口（原生标题栏可拖）⇒ 不要求该权限。"""
        problems = self._run(
            windows=[{"label": "main"}],
            caps=[{"identifier": "default", "windows": ["main"], "permissions": ["core:default"]}],
        )
        self.assertEqual(problems, [])

    def test_typo_permission_identifier_is_rejected(self):
        """权限标识拼错 ⇒ 静默不生效 ⇒ 必须报错。

        ⚠️ 判别力来源：manifest 里只有 `allow-start-dragging`，
        `allow-start-draggingg` 不在其中 ⇒ 必须被抓出来。
        """
        problems = self._run(
            windows=[{"label": "main"}],
            caps=[
                {
                    "identifier": "default",
                    "windows": ["main"],
                    "permissions": ["core:window:allow-start-draggingg"],
                }
            ],
        )
        self.assertTrue(problems, "拼错的权限标识必须报错")
        self.assertIn("allow-start-draggingg", problems[0])

    def test_permission_set_identifier_is_skipped(self):
        """权限**集**（`core:default`）在 manifest 里无条目 ⇒ 跳过，不误报。"""
        problems = self._run(
            windows=[{"label": "main"}],
            caps=[
                {
                    "identifier": "default",
                    "windows": ["main"],
                    "permissions": ["core:default", "core:window:default"],
                }
            ],
        )
        self.assertEqual(problems, [])


if __name__ == "__main__":
    unittest.main()
