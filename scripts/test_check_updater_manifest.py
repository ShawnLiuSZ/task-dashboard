#!/usr/bin/env python3
"""scripts/check-updater-manifest.py 的单测。

守住两件事：

1. **判定口径正确**：清单缺平台条目 / 条目字段为空 / version 对不上 ⇒ 必须报错；
   齐全 ⇒ 必须通过。**离线**跑（喂 fixture dict）⇒ 不依赖网络。
2. **期望的 key 集合与实际发版产物一致**：把 `PLATFORM_BUNDLES` 展开出的 key 数
   钉死（实测 v0.7.7 修好后的线上清单恰好 18 个）⇒ 矩阵的 bundle 集合若变了、
   而这张表没跟着改，单测会立刻失败（而不是等线上清单缺条目才发现）。

运行：python3 -m unittest discover -s scripts -p 'test_*.py'
"""

import importlib.util
import json
import sys
import unittest
from pathlib import Path


def _load(name, filename):
    """按文件名加载带连字符的模块（`check-updater-manifest.py` 不是合法 import 标识符）。"""
    path = Path(__file__).with_name(filename)
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


M = _load("check_updater_manifest", "check-updater-manifest.py")


def _entry(sig="c2ln", url="https://api.github.com/x/1"):
    return {"signature": sig, "url": url}


def _full_manifest():
    """一份「齐全」的清单（每个期望 key 都有条目）。"""
    return {
        "version": "0.7.7",
        "notes": "x",
        "pub_date": "2026-10-23T00:00:00Z",
        "platforms": {key: _entry() for key in M.expected_keys()},
    }


class ExpectedKeysTests(unittest.TestCase):
    """期望 key 集合的形状。"""

    def test_expected_keys_cover_all_platforms_and_bundles(self):
        keys = set(M.expected_keys())
        for platform, bundles in M.PLATFORM_BUNDLES.items():
            self.assertIn(platform, keys, f"缺少 primary key {platform}")
            for bundle in bundles:
                self.assertIn(f"{platform}-{bundle}", keys, f"缺少 {platform}-{bundle}")

    def test_expected_key_count_is_18(self):
        # 实测 v0.7.7 修好后的线上清单恰好 18 个 key（2 macOS + 2×3 windows + 2×4 linux）。
        # ⚠️ 矩阵的 bundle 集合若变了，这里要跟着改（同时改 PLATFORM_BUNDLES）。
        self.assertEqual(len(M.expected_keys()), 18)


class CheckManifestTests(unittest.TestCase):
    """`check_manifest` 的判定口径。"""

    def test_complete_manifest_passes(self):
        self.assertEqual(M.check_manifest(_full_manifest()), [])

    def test_missing_darwin_keys_are_reported(self):
        """v0.7.7 的真实故障形态：macOS 的 key 全丢。"""
        manifest = _full_manifest()
        for key in ("darwin-aarch64", "darwin-aarch64-app", "darwin-x86_64", "darwin-x86_64-app"):
            manifest["platforms"].pop(key)
        problems = M.check_manifest(manifest)
        self.assertTrue(problems, "缺 macOS 条目必须报错")
        joined = "\n".join(problems)
        self.assertIn("darwin-aarch64", joined)
        self.assertIn("darwin-x86_64", joined)

    def test_missing_one_bundle_variant_is_reported(self):
        manifest = _full_manifest()
        manifest["platforms"].pop("linux-x86_64-rpm")
        problems = M.check_manifest(manifest)
        self.assertTrue(problems)
        self.assertIn("linux-x86_64-rpm", "\n".join(problems))

    def test_empty_signature_is_reported(self):
        manifest = _full_manifest()
        manifest["platforms"]["darwin-aarch64"] = _entry(sig="  ", url="u")
        problems = M.check_manifest(manifest)
        self.assertTrue(problems)
        self.assertIn("signature", "\n".join(problems))

    def test_empty_url_is_reported(self):
        manifest = _full_manifest()
        manifest["platforms"]["windows-x86_64"] = _entry(sig="s", url="")
        problems = M.check_manifest(manifest)
        self.assertTrue(problems)
        self.assertIn("url", "\n".join(problems))

    def test_version_mismatch_with_tag_is_reported(self):
        problems = M.check_manifest(_full_manifest(), "v0.7.8")
        self.assertTrue(problems)
        self.assertIn("version", "\n".join(problems))

    def test_version_matches_tag_passes(self):
        self.assertEqual(M.check_manifest(_full_manifest(), "v0.7.7"), [])

    def test_manifest_without_platforms_object_is_rejected(self):
        problems = M.check_manifest({"version": "0.7.7"})
        self.assertTrue(problems)
        self.assertIn("platforms", "\n".join(problems))


class PublishedManifestTests(unittest.TestCase):
    """对**已发布**的线上清单做一次真实校验（需要网络 + GITHUB_TOKEN）。

    默认跳过（CI 的普通单测环境没有 token / 不该依赖网络）⇒ 发版时用
    `release.yml` 的 `updater-check` job 跑在线模式。
    """

    TAG = "v0.7.7"

    def test_published_manifest_has_all_platform_keys(self):
        import os

        if not (os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")):
            self.skipTest("无 GITHUB_TOKEN，跳过线上校验（由 release workflow 的门禁负责）")
        manifest = M.fetch_manifest(self.TAG)
        problems = M.check_manifest(manifest, self.TAG)
        self.assertEqual(problems, [], f"线上清单不完整：{problems}")


if __name__ == "__main__":
    unittest.main()
