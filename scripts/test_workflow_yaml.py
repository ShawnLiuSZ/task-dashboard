#!/usr/bin/env python3
"""scripts/check-workflow-yaml.py 的单测（Issue #284）。

这个检查器自己也会被 CI 跑，所以它有**双向**要求：

  * 不能误报 —— 一个误报就会让每个 PR 的 CI 都红，而且没人有时间去分辨是新 workflow
    的问题还是检查器的问题，最后的结果只能是把它从 CI 里删掉（等于没加）。
  * 不能漏报 —— 它存在的意义就是拦下「历史上真的会咬人」的那几类缺陷。

因此这里同时做两类验证：

  1. 正向回归：仓库里现存的全部 workflow 必须通过（见 TestRealWorkflows）。这是防误报的
     主防线 —— 检查器一旦改出误报，这个用例立刻红。
  2. 反向验证：每个声称能拦的缺陷类别，都用合成 workflow 验证「一定会被标记」。

运行：python3 -m unittest discover -s scripts -p 'test_*.py'
"""

import importlib.util
import sys
import unittest
from pathlib import Path


def _load(name, filename):
    """按文件名加载带连字符的模块（`check-workflow-yaml.py` 不是合法的 import 标识符）。

    `sys.modules[name] = module` 必须在 `exec_module` **之前** —— 被加载模块里有
    `@dataclass` 时会去 `sys.modules` 找自己的模块命名空间，缺失会直接 AttributeError。
    """
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


checker = _load("check_workflow_yaml", "check-workflow-yaml.py")
scan = checker.scan
strip_comment = checker.strip_comment
indent_of = checker.indent_of
parse_kv = checker.parse_kv


def errs(text: str) -> list[str]:
    return scan(text.splitlines())


# 最小合法 workflow：后续用例在这个骨架上做单点改动，保证被标记的就是那一个改动。
VALID = """\
name: demo

on:
  pull_request:

permissions:
  contents: write

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - name: Run
        run: python3 scripts/foo.py
"""


class ParseHelpersTest(unittest.TestCase):
    def test_parse_kv_splits_at_first_colon(self):
        self.assertEqual(parse_kv("if: >-"), ("if", ">-"))
        self.assertEqual(parse_kv("run: echo a:b"), ("run", "echo a:b"))
        self.assertEqual(parse_kv("uses: actions/checkout@v5"), ("uses", "actions/checkout@v5"))

    def test_parse_kv_empty_value(self):
        self.assertEqual(parse_kv("steps:"), ("steps", ""))

    def test_parse_kv_rejects_no_colon(self):
        self.assertIsNone(parse_kv("just some text"))

    def test_parse_kv_rejects_bad_key(self):
        self.assertIsNone(parse_kv("123 bad: value"))

    def test_indent_of(self):
        self.assertEqual(indent_of("a: b"), 0)
        self.assertEqual(indent_of("    if: >-"), 4)

    def test_strip_comment_preserves_hash_inside_expression(self):
        # `${{ }}` 表达式内部整体跳过 —— 表达式里的 `#` 是内容，不能当注释截断。
        self.assertEqual(
            strip_comment("if: ${{ github.event.number == 1 }} # ok"),
            "if: ${{ github.event.number == 1 }}",
        )

    def test_strip_comment_strips_trailing_comment(self):
        self.assertEqual(strip_comment('if: runner.os == "Linux" # only linux'), 'if: runner.os == "Linux"')

    def test_strip_comment_bare_hash_outside_expression_is_stripped(self):
        # 表达式外的裸 `#N`（如 `gh issue close #123`）会被当注释截断。
        # 这是有意的：本检查器只校验结构，不校验 `run:` 的值，截断无害。
        self.assertEqual(strip_comment("run: gh issue close #123"), "run: gh issue close")

    def test_strip_comment_expression_terminator_mid_line(self):
        # 回归：`}}` 只有 2 个字符，之前的实现用 `line[i:i+3] == "}}"` 比较 3 字符切片，
        # 导致只有 `}}` 恰好落在行尾时深度才会复位 —— 「表达式内的 # 不当注释」因此只在
        # 表达式位于行尾时成立。表达式夹在中间的写法（`&& ${{ y }}` 后接注释）必须也能工作。
        self.assertEqual(
            strip_comment("if: ${{ a.b }} && ${{ c.d }} # 注释"),
            "if: ${{ a.b }} && ${{ c.d }}",
        )
        # 表达式内的 `#`（issue 引用）保留，其后真正位于表达式外的注释仍被截断。
        self.assertEqual(
            strip_comment("if: ${{ x == '#123' }} && true # 注释"),
            "if: ${{ x == '#123' }} && true",
        )


class PositiveRegressionTest(unittest.TestCase):
    """仓库里现存的 workflow 必须全部通过 —— 这是防误报的主防线。"""

    def test_all_existing_workflows_pass(self):
        files = sorted(checker.WORKFLOWS_DIR.glob("*.yml")) + sorted(
            checker.WORKFLOWS_DIR.glob("*.yaml")
        )
        self.assertTrue(files, f"{checker.WORKFLOWS_DIR} 下没有 workflow 文件")
        for path in files:
            with self.subTest(workflow=path.name):
                problems = scan(path.read_text(encoding="utf-8").splitlines())
                self.assertEqual(problems, [], f"{path.name} 被误判：{problems}")

    def test_minimal_valid_workflow_passes(self):
        self.assertEqual(errs(VALID), [])


class NegativeDetectionTest(unittest.TestCase):
    """每个声称能拦的缺陷类别都必须真的被标记。"""

    def assert_flagged(self, text: str, needle: str):
        problems = errs(text)
        self.assertTrue(
            any(needle in p for p in problems),
            f"期望出现包含 {needle!r} 的问题，实际：{problems}",
        )

    def test_tab_indent(self):
        self.assert_flagged("name: demo\n\tjobs:\n", "tab")

    def test_odd_indent_on_structural_line(self):
        text = VALID.replace("  pull_request:", "   pull_request:")
        self.assert_flagged(text, "缩进 3 不是偶数")

    def test_missing_name(self):
        self.assert_flagged(VALID.replace("name: demo\n\n", ""), "缺少顶层 `name:`")

    def test_missing_on(self):
        self.assert_flagged(
            VALID.replace("on:\n  pull_request:\n", ""), "缺少顶层 `on:`"
        )

    def test_missing_jobs(self):
        self.assert_flagged(
            VALID.replace("jobs:\n  build:\n    runs-on: ubuntu-latest\n", ""),
            "缺少顶层 `jobs:`",
        )

    def test_on_without_trigger(self):
        self.assert_flagged(VALID.replace("  pull_request:\n", ""), "`on:` 下没有任何触发事件")

    def test_jobs_without_job(self):
        self.assert_flagged(VALID.replace("  build:\n    runs-on: ubuntu-latest\n", ""), "`jobs:` 下没有任何 job")

    def test_job_missing_runs_on(self):
        self.assert_flagged(
            VALID.replace("    runs-on: ubuntu-latest\n", ""), "缺少 `runs-on:`"
        )

    def test_empty_step(self):
        text = VALID.replace("      - name: Run\n        run: python3 scripts/foo.py", "      - name: Run")
        self.assert_flagged(text, "既没有 `uses:` 也没有 `run:`")

    def test_unpinned_third_party_action(self):
        self.assert_flagged(
            VALID.replace("actions/checkout@v5", "actions/checkout"), "未固定版本"
        )

    def test_local_action_not_flagged(self):
        text = VALID.replace("actions/checkout@v5", "./.github/actions/install-linux-deps")
        self.assertFalse(
            any("未固定版本" in p for p in errs(text)),
            f"本地 action 不应被要求固定版本：{errs(text)}",
        )

    def test_expression_with_yaml_conflicting_quote(self):
        text = VALID.replace('    runs-on: ubuntu-latest', '    if: ${{ "true" }}')
        self.assert_flagged(text, "引号冲突")

    def test_if_with_colon_space_unquoted(self):
        text = VALID.replace("      - name: Run", '        if: github.event.x == "a: b"\n      - name: Run')
        self.assert_flagged(text, "`if:` 表达式含 `: ` 但未加引号")

    def test_empty_permissions(self):
        self.assert_flagged(VALID.replace("  contents: write\n", ""), "没有任何 scope 声明")

    def test_bad_scope_in_permissions(self):
        self.assert_flagged(
            VALID.replace("  contents: write", "  contents: admin"), "不是合法的 scope 声明"
        )

    def test_duplicate_key_in_job(self):
        text = VALID.replace("    runs-on: ubuntu-latest", "    runs-on: ubuntu-latest\n    runs-on: windows-latest")
        self.assert_flagged(text, "重复")

    def test_missing_checkout_when_running_repo_script(self):
        text = VALID.replace("      - uses: actions/checkout@v5\n", "")
        self.assert_flagged(text, "缺少 `actions/checkout@*`")

    def test_checkout_present_silences_script_check(self):
        self.assertEqual(errs(VALID), [])

    def test_block_scalar_run_is_not_empty_step(self):
        # `release.yml` 的形状：`- name:` 之后隔了 `if:` / `env:` 才写 `run: |`。
        text = """\
name: demo

on:
  pull_request:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v5
      - name: Import cert
        if: runner.os == 'macOS'
        env:
          KEY: ${{ secrets.KEY }}
        run: |
          echo hi
"""
        self.assertEqual(errs(text), [])

    def test_odd_indent_inside_block_scalar_is_allowed(self):
        # `if: >-` 的续行常故意用非偶数缩进做视觉对齐 —— 块标量内部是自由文本。
        text = """\
name: demo

on:
  pull_request:

jobs:
  build:
    runs-on: ubuntu-latest
    if: >-
      ${{ github.event.pull_request.merged &&
          (github.event.pull_request.base.ref == 'develop' ||
           github.event.pull_request.base.ref == 'main') }}
    steps:
      - uses: actions/checkout@v5
"""
        self.assertEqual(errs(text), [])

    def test_matrix_include_items_are_not_steps(self):
        # `strategy.matrix.include` 的条目也是 `- key: value`，但不能被当成 step。
        text = """\
name: demo

on:
  workflow_dispatch:

jobs:
  build:
    strategy:
      matrix:
        include:
          - platform: macos-latest
            target: aarch64-apple-darwin
          - platform: ubuntu-latest
            target: x86_64-unknown-linux-gnu
    runs-on: ${{ matrix.platform }}
    steps:
      - name: Checkout
        uses: actions/checkout@v5
      - name: Build
        run: echo build
"""
        self.assertEqual(errs(text), [])

    def test_reusable_workflow_job_needs_no_runs_on(self):
        text = """\
name: demo

on:
  workflow_dispatch:

jobs:
  other:
    uses: ./.github/workflows/other.yml
"""
        self.assertEqual(errs(text), [])


if __name__ == "__main__":
    unittest.main()
