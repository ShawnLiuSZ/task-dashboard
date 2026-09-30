#!/usr/bin/env python3
"""文档链接完整性校验（Issue #239）。

背景
----
仓库的 markdown 文档长期靠人工维护链接，结果积累了三类缺陷，且**没有任何检查会碰到它们**
（CI 只跑 i18n 与 MCP 列名）：

1. **断链**——指向从未创建或已被删除的文档（如 `docs/issue-118-*.md`、`docs/perf-audit-optimization.md`
   被 CHANGELOG / 4 篇 KB 文档引用了很久）。
2. **`file://` 绝对路径**——形如 `file:///Users/<某人的家目录>/repo/app/...`，只在本机可用，
   他人 clone 后全部失效，且违反 `AGENTS.md §5.5`「内部链接用相对路径」。
3. **行号锚点**——形如 `app/src/db.rs#L1317`，行号必然随时间漂移，点击会落到**完全无关的代码**
   （符号名本身没变，行号变了）。

本脚本把这层检查补上，零依赖（只用标准库），失败即非零退出。

用法：`python3 scripts/check-doc-links.py`（CI 里同一条命令）
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# 不参与扫描的目录（构建产物 / 依赖 / VCS）。
SKIP_DIRS = {"node_modules", "target", ".git", "dist", ".venv", "__pycache__"}

# markdown 行内链接 ](target) 与 HTML href="target"
LINK_RE = re.compile(r'\]\(([^)\s]+?)\)|href="([^"]+?)"')
# 行号锚点：GitHub 风格 #L12 或 #L12-L34
LINE_ANCHOR_RE = re.compile(r"#L\d+(?:-L?\d+)?")
# 外部链接前缀，不校验其可达性（离线 CI 无法可靠判断）
EXTERNAL_PREFIXES = ("http://", "https://", "mailto:", "tel:", "//")

# 「索引文件」——`docs/*.md` 必须至少被其中一个引用（Issue #330）。
# 理由：`AGENTS.md §5.5` 早就要求「新增文档后必须在 README / CHANGELOG 建立反向链接
# （避免孤岛文档）」，但此前没有任何检查会碰到它。实测 `docs/` 下 **15 篇**知识库文档
# 既不在 README 索引、也不在 CHANGELOG —— 它们只能靠「知道文件名」才找得到，
# 等于写完就沉底（#330 一并补上反链 + 本检测防回归）。
INDEX_FILES = ("README.md", "README.en.md", "docs/CHANGELOG.md", "docs/CHANGELOG.en.md")

# 围栏代码块（``` 或 ~~~），以及行内代码 span（`...`）。
# 这两处出现的「链接」是**被描述的语法示例**（本文档自己就会写 `](app/...)` 这类反例），
# 不应参与校验；否则文档一描述某类缺陷就会把自己判成缺陷。
FENCE_RE = re.compile(r"^([ \t]*)(`{3,}|~{3,})[^\n]*\n.*?^\1\2[^\n]*$", re.MULTILINE | re.DOTALL)
INLINE_CODE_RE = re.compile(r"`[^`\n]*`")


def blank_preserving_newlines(m: re.Match[str]) -> str:
    """把匹配到的内容替换成全空格，但保留换行 —— 保证行号仍然准确。"""
    return "".join("\n" if ch == "\n" else " " for ch in m.group(0))


def mask_code(text: str) -> str:
    """屏蔽代码块与行内代码，使行号保持不变。"""
    return INLINE_CODE_RE.sub(blank_preserving_newlines, FENCE_RE.sub(blank_preserving_newlines, text))


def iter_markdown() -> list[Path]:
    out: list[Path] = []
    for p in sorted(ROOT.rglob("*.md")):
        if SKIP_DIRS & set(p.relative_to(ROOT).parts):
            continue
        out.append(p)
    return out


def is_kb_doc(rel: str) -> bool:
    """`docs/` **直属**（不再下钻子目录）的 markdown 才算知识库文档。

    `docs/` 下的 `CHANGELOG.md` / `CHANGELOG.en.md` 也算 —— 它们被 README 引用，
    本来就是索引的一部分，纳入不会误报。
    """
    return rel.startswith("docs/") and rel.count("/") == 1 and rel.endswith(".md")


def find_orphans(
    docs_rels: list[str],
    inbound: dict[str, set[str]],
    index_files: tuple[str, ...] = INDEX_FILES,
) -> list[tuple[str, list[str]]]:
    """找出**孤岛文档**：未被任何「索引文件」引用的知识库文档。

    返回 `[(文档相对路径, 引用它的其它文件列表)]`，按输入顺序排列（已排序）。
    空列表 = 全部文档都能从 README / CHANGELOG 找到入口。
    """
    index_set = set(index_files)
    out: list[tuple[str, list[str]]] = []
    for rel in docs_rels:
        sources = inbound.get(rel, set())
        if not (sources & index_set):
            out.append((rel, sorted(s for s in sources if s not in index_set)))
    return out


def main() -> int:
    files = iter_markdown()
    if not files:
        print("✗ 未找到任何 markdown 文件，检查脚本所在目录是否正确")
        return 1

    broken: list[str] = []
    file_urls: list[str] = []
    anchors: list[str] = []
    # 反向引用表：目标文件（相对仓库根的 posix 路径）→ 引用它的源文件集合。
    inbound: dict[str, set[str]] = {}

    for path in files:
        raw = path.read_text(encoding="utf-8", errors="replace")
        text = mask_code(raw)
        rel = path.relative_to(ROOT)
        for m in LINK_RE.finditer(text):
            target = m.group(1) or m.group(2)
            if not target or target.startswith(EXTERNAL_PREFIXES) or target.startswith("#"):
                continue
            line_no = text[: m.start()].count("\n") + 1
            where = f"{rel}:{line_no}"

            if "file://" in target:
                file_urls.append(f"{where} -> {target}")
                # file:// 链接同时按路径判定，可能又断链，只报一次类别即可
                continue

            if LINE_ANCHOR_RE.search(target):
                anchors.append(f"{where} -> {target}")

            path_part = target.split("#", 1)[0].split("?", 1)[0]
            if not path_part:
                continue
            resolved = (path.parent / path_part).resolve()
            try:
                inbound.setdefault(str(resolved.relative_to(ROOT)), set()).add(str(rel))
            except ValueError:
                # 指向仓库外的路径（理论上不该出现），不计入反向引用表。
                pass
            if not resolved.exists():
                broken.append(f"{where} -> {target}")

    problems = False

    if broken:
        problems = True
        print(f"✗ 断链 {len(broken)} 处（目标文件不存在）：")
        for b in broken:
            print(f"  - {b}")

    if file_urls:
        problems = True
        print(f"✗ file:// 绝对路径 {len(file_urls)} 处（应改为相对路径，见 AGENTS.md §5.5）：")
        for b in file_urls:
            print(f"  - {b}")

    if anchors:
        problems = True
        print(f"✗ 行号锚点 {len(anchors)} 处（行号会漂移，请改为指向文件 + 符号名）：")
        for b in anchors:
            print(f"  - {b}")

    # 孤岛文档：`docs/*.md` 必须至少被一个「索引文件」引用（Issue #330）。
    docs_rels = [str(p.relative_to(ROOT)) for p in files if is_kb_doc(str(p.relative_to(ROOT)))]
    orphan_pairs = find_orphans(docs_rels, inbound)
    orphans = [
        f"{rel} {'（仅被 ' + ', '.join(others) + ' 引用）' if others else '（没有任何文档引用）'}"
        for rel, others in orphan_pairs
    ]

    if orphans:
        problems = True
        print(
            f"✗ 孤岛文档 {len(orphans)} 篇"
            "（须被 README / CHANGELOG 索引，见 AGENTS.md §5.5）："
        )
        for o in orphans:
            print(f"  - {o}")

    if problems:
        print(
            "\n  修复提示：\n"
            "  - 断链：补写缺失文档，或改为正确的相对路径；\n"
            "  - file:// → 用相对路径，例如 `../app/src-tauri/src/lib.rs`；\n"
            "  - 行号锚点 → 删掉 `#Lxxx`，把符号名写进链接文本（如 `[db.rs](../app/src-tauri/src/db.rs)`）；\n"
            "  - 孤岛文档 → 在 README.md 的「文档」清单（或 CHANGELOG 对应版本块）里补一条反链。"
        )
        return 1

    print(
        f"✓ 文档链接校验通过：{len(files)} 个 markdown 文件，"
        "无断链 / 无 file:// / 无行号锚点 / 无孤岛文档"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
