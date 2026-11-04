#!/usr/bin/env python3
"""Tauri capability 权限校验（Issue #533）。

背景
----
`titleBarStyle: "Overlay"`（macOS 透明标题栏覆盖层）有一个**隐式权限依赖**：

- Overlay 模式下原生标题栏不再提供拖拽区 ⇒ 窗口拖动**完全依赖**前端
  `data-tauri-drag-region` ⇒ Tauri 的 drag.js 在 mousedown 时调
  `invoke('plugin:window|start_dragging')`；
- 而 **`core:window:default` 权限集里没有 `allow-start-dragging`**
  （实测 28 条：`activity-name / available-monitors / … / internal-toggle-maximize /
  is-visible / theme / title`）⇒ 不显式授权 ⇒ **ACL 拒绝该命令** ⇒
  **窗口完全拖不动**。

这个坑的特点是「**加功能时顺手引入、删功能时忘了带走**」：
`#520` 给主窗口加了 Overlay + drag-region（为了在标题栏里放按钮），
但没加 `allow-start-dragging` ⇒ 从那版起窗口就拖不动了，而**没有任何自动化校验**
会发现 —— 编译通过、测试全绿、CI 全绿，只有用户真去拖窗口才会暴露。

本脚本补上这层校验（零第三方依赖，只用标准库）：

1. 若 `tauri.conf.json` 里**任一窗口**用了 `titleBarStyle: "Overlay"`
   ⇒ 必须存在某个 capability 授予 `core:window:allow-start-dragging`
   （且该 capability 的 `windows` 覆盖到那个窗口）；
2. `capabilities/*.json` 里引用的每个权限标识都必须是**已知的 Tauri 权限**
   （防手写错标识名 ⇒ 静默不生效 ⇒ 又变成「没人发现」的坑）。

用法：`python3 scripts/check-capabilities.py`（CI 里同一条命令）
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

TAURI_CONF = ROOT / "app" / "src-tauri" / "tauri.conf.json"
CAP_DIR = ROOT / "app" / "src-tauri" / "capabilities"
# 编译期生成的 ACL manifest —— 权限名的权威清单。
MANIFEST = ROOT / "app" / "src-tauri" / "gen" / "schemas" / "acl-manifests.json"

# 窗口用了 Overlay（透明标题栏覆盖层）时，拖拽只能靠 `start_dragging` ⇒ 必须显式授权。
DRAG_PERMISSION = "core:window:allow-start-dragging"

# 拖拽相关的其它权限：跟着一起检查，避免「只加了 start-dragging 又漏了 maximize」。
DRAG_PERMISSIONS = (DRAG_PERMISSION, "core:window:allow-internal-toggle-maximize")


def _load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _window_labels(conf: dict) -> list[tuple[str, dict]]:
    """返回 [(label, window 配置)]。Tauri 里窗口可写在 `app.windows` 或顶层 `windows`。"""
    app = conf.get("app", {}) or {}
    windows = app.get("windows") or conf.get("windows") or []
    out = []
    for w in windows:
        if isinstance(w, dict) and w.get("label"):
            out.append((w["label"], w))
    return out


def _known_permissions() -> dict[str, set[str]]:
    """从编译期生成的 ACL manifest 里读出「插件 → 权限名集合」。

    manifest 不存在（未编译）⇒ 返回空 dict ⇒ 调用方跳过该类校验（不误报）。
    """
    if not MANIFEST.exists():
        return {}
    try:
        data = json.loads(MANIFEST.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    out: dict[str, set[str]] = {}
    for plugin, manifest in data.items():
        if not isinstance(manifest, dict):
            continue
        perms = set((manifest.get("permissions") or {}).keys())
        if perms:
            out[plugin] = perms
    return out


def _glob_match(pattern: str, label: str) -> bool:
    """capability 的 `windows` 支持 glob（`Pattern::new(window)`）。支持 `*` 与 `?`。"""
    if pattern == label:
        return True
    if "*" not in pattern and "?" not in pattern:
        return False
    # 简单 glob：把 `*` 转成 `.*`、`?` 转成 `.`，其余按字面量（转义正则元字符）。
    import re

    rx = "".join(".*" if ch == "*" else "." if ch == "?" else re.escape(ch) for ch in pattern)
    return re.fullmatch(rx, label) is not None


def check() -> list[str]:
    """返回问题列表（空 = 全部通过）。"""
    problems: list[str] = []

    if not TAURI_CONF.exists():
        return [f"找不到 {TAURI_CONF}"]
    conf = _load_json(TAURI_CONF)

    caps: list[dict] = []
    if CAP_DIR.exists():
        for f in sorted(CAP_DIR.glob("*.json")):
            try:
                caps.append(_load_json(f))
            except json.JSONDecodeError as e:
                problems.append(f"{f.name}: JSON 解析失败 —— {e}")

    # ---- 1) Overlay 窗口必须有 start-dragging 权限 ----
    for label, w in _window_labels(conf):
        style = str(w.get("titleBarStyle") or "")
        if style.lower() != "overlay":
            continue
        granted = False
        for cap in caps:
            perms = cap.get("permissions") or []
            if DRAG_PERMISSION not in perms:
                continue
            win_globs = cap.get("windows") or []
            if not win_globs or any(_glob_match(g, label) for g in win_globs):
                granted = True
                break
        if not granted:
            problems.append(
                f'窗口 "{label}" 用了 titleBarStyle="Overlay" ⇒ 拖动只能靠 '
                f"`data-tauri-drag-region` → `plugin:window|start_dragging`，"
                f"但没有任何 capability 给它授予 `{DRAG_PERMISSION}`"
                f"（`core:window:default` 不含该项）⇒ **窗口会拖不动**。"
                f'请在 app/src-tauri/capabilities/*.json 里加 `{DRAG_PERMISSION}`。'
            )

    # ---- 2) 权限标识拼写检查（防手写错、静默不生效）----
    # 用**编译期生成的 ACL manifest**（`gen/schemas/acl-manifests.json`）作权威清单：
    # 形如 `core:window:allow-xxx` 的标识，其 `allow-xxx` 必须真的存在于该插件的
    # `permissions` 里 ⇒ 拼错（如 `allow-start-draggingg`）会被抓住。
    #
    # ⚠️ 权限**集**（`core:default` / `core:window:default`）在 manifest 里没有条目
    # （`permission_sets` 为空 —— 集在插件 build 阶段展开）⇒ 跳过这类标识。
    known = _known_permissions()
    for cap in caps:
        for perm in cap.get("permissions") or []:
            if not isinstance(perm, str):
                continue
            if not perm.startswith("core:"):
                problems.append(
                    f'capability "{cap.get("identifier")}" 的权限标识 "{perm}" '
                    f"不像合法的 Tauri 权限（应以 core: 开头）⇒ 可能静默不生效。"
                )
                continue
            parts = perm.split(":")
            if len(parts) != 3 or not parts[2].startswith("allow-"):
                continue  # 权限集（如 core:default）⇒ manifest 里无条目，跳过
            plugin, name = f"{parts[0]}:{parts[1]}", parts[2]
            if not known:
                continue  # manifest 未生成（首次 clone / 未编译）⇒ 跳过
            if plugin not in known:
                problems.append(
                    f'capability "{cap.get("identifier")}" 引用了未知插件 "{plugin}"'
                    f'（权限标识 "{perm}"）⇒ 静默不生效。'
                )
            elif name not in known[plugin]:
                problems.append(
                    f'capability "{cap.get("identifier")}" 的权限标识 "{perm}" 不存在'
                    f"（{plugin} 没有 `{name}`）⇒ 拼错了？静默不生效。"
                )

    return problems


def main() -> int:
    problems = check()
    if problems:
        print("✗ capability 权限校验失败：", file=sys.stderr)
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        return 1
    print("✓ capability 权限校验通过：Overlay 窗口已授权 start-dragging，权限标识合法")
    return 0


if __name__ == "__main__":
    sys.exit(main())
