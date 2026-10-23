#!/usr/bin/env python3
"""Updater 清单（`latest.json`）完整性校验（Issue #476 后续）。

背景
----
应用内更新（Tauri updater）靠 Release 上的 `latest.json` 定位「当前平台该下哪个
安装包」。清单缺了当前平台的 key ⇒ 客户端报：

    检查更新失败：None of the fallback platforms
    `["darwin-aarch64-app", "darwin-aarch64"]` were found in the response
    `platforms` object

**v0.7.7 实测踩中**：清单里 14 个 key 全部是 Linux / Windows，**一个 macOS 的
都没有** ⇒ macOS 用户完全无法应用内更新。

根因（tauri-action v1 的实现，见 `src/upload-version-json.ts`）：
`uploadVersionJSON()` 在**每个矩阵 job 结束时各跑一次**，每次都是
「下载已有清单 → 合并自己平台的条目 → **删掉旧资产** → 上传新的」。
GitHub 的 release 资产**不能同名覆盖** ⇒ 必须先删 ⇒ **6 个 job 并发时互相踩**：
后完成的 job 往往拿着**过期**的内容覆盖，把先完成平台的条目抹掉。
实测 v0.7.7：macOS 两个 job 最早完成（03:53 / 03:55），条目被随后完成的
Linux / Windows job 覆盖 ⇒ macOS 条目全丢。

本脚本补上这层校验（零第三方依赖，只用标准库）：

1. 清单必须包含**每个平台的 primary key**（`{os}-{arch}`）**与各 bundle 变体**
   （`{os}-{arch}-{bundle}`）—— 与 `release.yml` 的矩阵一一对应；
2. 每个条目的 `signature` / `url` 必须非空；
3. 清单的 `version` 必须与 tag 对得上（`v0.7.7` ⇒ `0.7.7`）。

用法
----
离线（校验本地清单文件）::

    python3 scripts/check-updater-manifest.py --file latest.json

在线（校验某个已发布 tag 的清单）::

    python3 scripts/check-updater-manifest.py --tag v0.7.7

CI（`release.yml` 的 `updater-check` job）里用的是在线模式：**清单不完整就让
发版变红**，而不是静默发一个装不了更新的版本。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

# 每个平台（os-arch）及其 bundle 集合。
#
# ⚠️ 必须与 `.github/workflows/release.yml` 的矩阵一一对应（bundle 集合改了这里
# 也要改）—— 本表是「这个版本应该有哪些平台条目」的唯一事实来源。
#
# 实测 v0.7.7 修好后的清单恰好 18 个 key：
#   darwin-aarch64 / -app          （.app.tar.gz）
#   darwin-x86_64  / -app
#   windows-x86_64  / -nsis / -msi  （setup.exe / en-US.msi）
#   windows-aarch64 / -nsis / -msi
#   linux-x86_64   / -appimage / -deb / -rpm
#   linux-aarch64  / -appimage / -deb / -rpm
PLATFORM_BUNDLES: dict[str, tuple[str, ...]] = {
    "darwin-aarch64": ("app",),
    "darwin-x86_64": ("app",),
    "windows-x86_64": ("nsis", "msi"),
    "windows-aarch64": ("nsis", "msi"),
    "linux-x86_64": ("appimage", "deb", "rpm"),
    "linux-aarch64": ("appimage", "deb", "rpm"),
}

DEFAULT_REPO = "ShawnLiuSZ/task-dashboard"
GITHUB_API = "https://api.github.com"


def expected_keys() -> list[str]:
    """按 `PLATFORM_BUNDLES` 展开出「应该存在」的 key 列表。"""
    keys: list[str] = []
    for platform, bundles in PLATFORM_BUNDLES.items():
        keys.append(platform)
        keys.extend(f"{platform}-{bundle}" for bundle in bundles)
    return keys


def check_manifest(manifest: dict, tag: str | None = None) -> list[str]:
    """校验清单，返回问题列表（空列表 = 通过）。

    纯函数：只吃 dict、不碰网络 ⇒ 单测可直接喂 fixture。
    """
    problems: list[str] = []

    platforms = manifest.get("platforms")
    if not isinstance(platforms, dict):
        return ["清单缺少 `platforms` 对象（不是合法的 updater 清单）"]

    missing = [key for key in expected_keys() if key not in platforms]
    if missing:
        problems.append(
            "清单缺少这些平台条目（客户端会报「fallback platforms were not found」）："
            + "、".join(missing)
        )

    for key in expected_keys():
        entry = platforms.get(key)
        if not isinstance(entry, dict):
            continue
        if not str(entry.get("signature") or "").strip():
            problems.append(f"条目 `{key}` 的 signature 为空（签名缺失 ⇒ 安装包无法校验）")
        if not str(entry.get("url") or "").strip():
            problems.append(f"条目 `{key}` 的 url 为空（客户端不知道去哪下载）")

    if tag:
        want = tag[1:] if tag.startswith("v") else tag
        got = str(manifest.get("version") or "")
        if got != want:
            problems.append(f"清单 version={got!r} 与 tag {tag!r} 对不上（应为 {want!r}）")

    return problems


def fetch_manifest(tag: str, repo: str = DEFAULT_REPO) -> dict:
    """下载某个 tag 的 Release 上的 `latest.json`。

    走 GitHub REST API（零第三方依赖）：
    ① 查 release → 找名为 `latest.json` 的资产；
    ② 用 `Accept: application/octet-stream` 取资产的**原始内容**。
    """
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "taskboard-check"}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    req = urllib.request.Request(f"{GITHUB_API}/repos/{repo}/releases/tags/{tag}", headers=headers)
    with urllib.request.urlopen(req, timeout=30) as resp:
        release = json.loads(resp.read().decode("utf-8"))

    assets = [a for a in release.get("assets", []) if a.get("name") == "latest.json"]
    if not assets:
        raise RuntimeError(f"Release {tag} 上没有 latest.json 资产（updater 无从读取）")
    asset = assets[0]

    # 资产内容要用 octet-stream 取（默认的 JSON 视图是元数据，不是文件内容）。
    raw_headers = dict(headers)
    raw_headers["Accept"] = "application/octet-stream"
    req = urllib.request.Request(asset["url"], headers=raw_headers)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser(description="校验 updater 清单（latest.json）的平台完整性")
    parser.add_argument("--file", help="校验本地清单文件（离线）")
    parser.add_argument("--tag", help="校验已发布 tag 的清单（在线，需要 GITHUB_TOKEN）")
    parser.add_argument("--repo", default=DEFAULT_REPO, help="仓库 slug（默认 %(default)s）")
    args = parser.parse_args()

    if not args.file and not args.tag:
        parser.error("必须给 --file 或 --tag 之一")

    if args.file:
        path = Path(args.file)
        if not path.exists():
            print(f"✗ 清单文件不存在：{path}", file=sys.stderr)
            return 1
        manifest = json.loads(path.read_text(encoding="utf-8"))
    else:
        try:
            manifest = fetch_manifest(args.tag, args.repo)
        except (urllib.error.URLError, RuntimeError, json.JSONDecodeError) as e:
            print(f"✗ 无法获取 {args.tag} 的清单：{e}", file=sys.stderr)
            return 1

    problems = check_manifest(manifest, args.tag)
    if problems:
        target = args.file or args.tag
        print(f"✗ updater 清单校验失败（{target}）：", file=sys.stderr)
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        return 1

    source = args.file or f"{args.tag} 的线上清单"
    print(f"✓ updater 清单校验通过：{source}（{len(expected_keys())} 个平台条目齐全）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
