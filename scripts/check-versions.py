#!/usr/bin/env python3
"""版本号一致性校验（Issue #330）。

背景
----
仓库的版本号分散在 **5 个文件**里，发版时要手动对齐，但**没有任何自动化校验**：

| 文件 | 字段 | 角色 |
|---|---|---|
| `app/package.json` | `version` | 前端包版本（权威源） |
| `app/package-lock.json` | `version` + `packages[""].version` | npm 锁文件（须随包版本走） |
| `app/src-tauri/Cargo.toml` | `[package] version` | Rust crate 版本 |
| `app/src-tauri/tauri.conf.json` | `version` | Tauri 打包版本（决定安装包名） |
| `app/src-tauri/Cargo.lock` | `[[package]] name="taskboard"` 的 `version` | cargo 锁文件 |

实测结果：前 4 处都是 `0.6.5`，而 **`package-lock.json` 停在 `0.4.0`**（落后两个大版本），
且 `AGENTS.md §4.3 / §6.4` 与 `release.yml` 的注释都只写「对齐**三处** version」——
文档与实际清单不一致，谁也没发现，因为**全仓库没有任何一步校验过这件事**。

本脚本补上这层校验，零第三方依赖（只用标准库）：

1. 上述 5 个文件的版本号必须**完全一致**；
2. `README.md` / `README.en.md` 里代表「当前版本」的字符串（`最新 vX.Y.Z` / `latest vX.Y.Z`
   与尾注 `版本 vX.Y.Z` / `Version vX.Y.Z`）必须与之一致 —— 实测两处尾注分别停在
   `v0.6.4` 与 `v0.6.0`，是同一类「没人校验所以漂移」的漂移；
3. 若环境变量 `GITHUB_REF_NAME` / `TAG_NAME` 提供了 tag（形如 `v0.6.5`），则一并比对
   —— 防止「打了 v0.7.0 的 tag 但文件还写 0.6.5」这类只在 Release 落地后才暴露的错配。

用法：`python3 scripts/check-versions.py`（CI 里同一条命令）
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# 代表「当前版本」的 README 字符串。刻意**不**匹配历史引用（`v0.3.24 及以下`、
# `v0.3.10 新增`、`v0.3.50 CHANGELOG`）—— 那些是版本历史叙述，不该随当前版本漂移。
README_VERSION_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("最新版引用", re.compile(r"(?:最新|latest)\s+v(\d+\.\d+\.\d+)")),
    ("尾注版本", re.compile(r"(?m)^>\s*(?:版本|Version)\s+v(\d+\.\d+\.\d+)")),
)

SEMVER = r"\d+\.\d+\.\d+"


def json_version(text: str, field: str = "version") -> str:
    """从 `package.json` / `tauri.conf.json` 这类 JSON 里取版本字段。"""
    return json.loads(text)[field]


def package_lock_versions(text: str) -> list[tuple[str, str]]:
    """`package-lock.json` 的版本出现在两处，两处都必须对。

    npm 7+ 的 lockfile v2/v3 同时保留顶层 `version`（兼容旧工具）与
    `packages[""].version`（新格式），只改一处会让其中一类工具读到旧值。
    """
    data = json.loads(text)
    out: list[tuple[str, str]] = []
    if "version" in data:
        out.append(("顶层 version", str(data["version"])))
    root = data.get("packages", {}).get("", {})
    if "version" in root:
        out.append(("packages[\"\"].version", str(root["version"])))
    return out


def toml_section_value(text: str, section: str, key: str) -> str | None:
    """读取 TOML 某个 `[section]` 下的 `key = "..."`（逐行解析，不引 tomllib）。

    不引 `tomllib` 的理由：本仓库 `scripts/` 的既有约定是「标准库 + 3.11 以下也能跑」，
    而 `tomllib` 是 3.11 才进标准库；这里的 TOML 形状极简单（只有一层 section + 字符串值），
    手写解析的复杂度远低于为它抬升解释器下限。
    """
    current: str | None = None
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        m = re.match(r"^\[([^\]]+)\]", stripped)
        if m:
            current = m.group(1).strip()
            continue
        if current != section:
            continue
        m = re.match(rf"^{re.escape(key)}\s*=\s*\"([^\"]*)\"", stripped)
        if m:
            return m.group(1)
    return None


def cargo_toml_version(text: str) -> str | None:
    return toml_section_value(text, "package", "version")


def cargo_lock_version(text: str, name: str = "taskboard") -> str | None:
    """在 `Cargo.lock` 里找 `[[package]]` 块，取 `name` 匹配那块的 `version`。"""
    for block in text.split("[[package]]"):
        m = re.search(rf"^\s*name\s*=\s*\"{re.escape(name)}\"\s*$", block, re.M)
        if not m:
            continue
        v = re.search(rf"^\s*version\s*=\s*\"([^\"]+)\"\s*$", block, re.M)
        if v:
            return v.group(1)
    return None


def readme_version_refs(text: str) -> list[tuple[str, str]]:
    """取 README 里代表「当前版本」的字符串，返回 (说明, 版本)。"""
    out: list[tuple[str, str]] = []
    for label, pattern in README_VERSION_PATTERNS:
        for m in pattern.finditer(text):
            out.append((label, m.group(1)))
    return out


def strip_tag_prefix(tag: str) -> str:
    """`v0.6.5` / `refs/tags/v0.6.5` / `0.6.5` → `0.6.5`。"""
    t = tag.strip().rsplit("/", 1)[-1]
    return t[1:] if t[:1] in ("v", "V") else t


def main() -> int:
    def read(rel: str) -> str:
        return (ROOT / rel).read_text(encoding="utf-8")

    problems: list[str] = []

    # ---- 1. 五个文件的版本号必须一致 -------------------------------------- #
    canonical = json_version(read("app/package.json"))

    observed: list[tuple[str, str]] = [("app/package.json", canonical)]
    for label, value in package_lock_versions(read("app/package-lock.json")):
        observed.append((f"app/package-lock.json（{label}）", value))
    cargo_toml = cargo_toml_version(read("app/src-tauri/Cargo.toml"))
    observed.append(("app/src-tauri/Cargo.toml", cargo_toml or "(解析失败)"))
    observed.append(
        (
            "app/src-tauri/tauri.conf.json",
            json_version(read("app/src-tauri/tauri.conf.json")),
        )
    )
    cargo_lock = cargo_lock_version(read("app/src-tauri/Cargo.lock"))
    observed.append(("app/src-tauri/Cargo.lock", cargo_lock or "(解析失败)"))

    for label, value in observed:
        if value != canonical:
            problems.append(f"{label} = {value}，应为 {canonical}")

    # 解析失败（而不是值不同）单独提示，避免「找不到」被误读成「值不对」。
    if cargo_toml is None:
        problems.append("app/src-tauri/Cargo.toml 里找不到 [package] version")
    if cargo_lock is None:
        problems.append('app/src-tauri/Cargo.lock 里找不到 name = "taskboard" 的 [[package]]')

    # ---- 2. README 的「当前版本」字符串 ----------------------------------- #
    for rel in ("README.md", "README.en.md"):
        refs = readme_version_refs(read(rel))
        if not refs:
            problems.append(f"{rel} 里找不到任何「当前版本」字符串（校验规则可能已失效）")
        for label, value in refs:
            if value != canonical:
                problems.append(f"{rel}（{label}）= v{value}，应为 v{canonical}")

    # ---- 3. 可选：与触发本次 CI 的 tag 比对 -------------------------------- #
    tag = os.environ.get("GITHUB_REF_NAME") or os.environ.get("TAG_NAME") or ""
    tag_version = strip_tag_prefix(tag) if tag else ""
    if re.fullmatch(SEMVER, tag_version) and tag_version != canonical:
        problems.append(f"tag {tag} 指向 {tag_version}，与文件里的 {canonical} 不一致")

    if problems:
        print(f"✗ 版本号一致性校验失败（{len(problems)} 项）：")
        for p in problems:
            print(f"  - {p}")
        print(
            "\n  修复提示：以 app/package.json 为准，同步其余 4 个文件与 README 尾注；\n"
            "  发版清单见 AGENTS.md §4.3（「四处 + lockfile」）。"
        )
        return 1

    print(
        f"✓ 版本号一致性校验通过：{canonical}"
        f"（{len(observed)} 处文件字段 + README 中英各 2 处引用"
        + (f"，tag {tag}" if tag_version else "")
        + "）"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
