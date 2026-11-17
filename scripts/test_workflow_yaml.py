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
# #539：checkout 固定到完整 40 位 commit SHA 且显式 `persist-credentials: false`，
# 使骨架满足新增的 SHA 固定 / persist 两类判定 —— 单点改动某个 step 时，不会因骨架本身
# 不合规而淹没真正的信号。
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
      - uses: actions/checkout@5c48d5b1b0aa30e9a9d3beba20aa9e3e4a2cbc66
        with:
          persist-credentials: false
      - name: Run
        run: python3 scripts/foo.py
"""

# #539：骨架里 checkout 固定到的 commit SHA（测试里做单点替换时复用）。
SHA = "5c48d5b1b0aa30e9a9d3beba20aa9e3e4a2cbc66"


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

    def test_tab_in_comment_not_flagged(self):
        """#569：tab 只禁**缩进**；注释里的 tab 是合法 YAML，不得误报。

        反向验证：把 `\t in leading` 改回 `\t in raw` ⇒ 本用例变红。
        """
        text = VALID.replace(
            "        run: python3 scripts/foo.py",
            "        run: python3 scripts/foo.py\n        # 注释\t含 tab",
        )
        self.assertEqual(errs(text), [])

    def test_with_inline_persist_credentials_false_ok(self):
        """#569：`with: {persist-credentials: false}` 内联映射是合法写法，不得误报 VULN-02。

        反向验证：把内联映射分支的 `persist_credentials_false` 赋值移除 ⇒ 本用例变红。
        """
        text = VALID.replace(
            "        with:\n          persist-credentials: false\n",
            "        with: {persist-credentials: false}\n",
        )
        self.assertEqual(errs(text), [])

    def test_with_inline_persist_credentials_true_flagged(self):
        """#569 反向：内联映射里的 `true` 仍算未禁用，必报。"""
        text = VALID.replace(
            "        with:\n          persist-credentials: false\n",
            "        with: {persist-credentials: true}\n",
        )
        self.assert_flagged(text, "缺少 `with: persist-credentials: false`")

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
        # #539 VULN-01：第三方 action 没写 `@ref` ⇒ 未固定，必报。
        self.assert_flagged(
            VALID.replace(f"actions/checkout@{SHA}", "actions/checkout"), "未固定版本"
        )

    def test_local_action_not_flagged(self):
        text = VALID.replace(f"actions/checkout@{SHA}", "./.github/actions/install-linux-deps")
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
        # #539：骨架 checkout 现为三行（uses + with: + persist-credentials），整段移除。
        text = VALID.replace(
            f"      - uses: actions/checkout@{SHA}\n"
            "        with:\n"
            "          persist-credentials: false\n",
            "",
        )
        self.assert_flagged(text, "缺少 `actions/checkout@*`")

    def test_checkout_present_silences_script_check(self):
        self.assertEqual(errs(VALID), [])

    def test_other_job_checkout_does_not_mask_missing(self):
        """#579（低危-4）：A job 跑脚本缺 checkout，B job 有 checkout —— 必须报 A。

        原实现文件级 `runs_scripts` + 全文件字符串搜 `actions/checkout@`，B 的
        checkout 会命中字符串 ⇒ 掩盖 A 的缺失。per-job 后只认本 job。
        """
        # 移除 build 的 checkout，追加一个带 checkout 的 other job。
        no_checkout = VALID.replace(
            f"      - uses: actions/checkout@{SHA}\n"
            "        with:\n"
            "          persist-credentials: false\n",
            "",
        )
        # 在 jobs 末尾追加 other job（在 build 的 steps 后、文件末尾前追加）。
        text = no_checkout.replace(
            "        run: python3 scripts/foo.py",
            "        run: python3 scripts/foo.py\n"
            "  other:\n"
            "    runs-on: ubuntu-latest\n"
            "    steps:\n"
            f"      - uses: actions/checkout@{SHA}\n"
            "        with:\n"
            "          persist-credentials: false",
        )
        self.assert_flagged(text, "缺少 `actions/checkout@*`")

    def test_commented_checkout_does_not_mask_missing(self):
        """#579（低危-4）：注释掉的 checkout 不得掩盖缺失 —— 原实现字符串搜原始行命中。"""
        text = VALID.replace(
            f"      - uses: actions/checkout@{SHA}\n",
            f"      # - uses: actions/checkout@{SHA}\n",
        )
        self.assert_flagged(text, "缺少 `actions/checkout@*`")

    def test_local_action_counts_as_checkout(self):
        """#579（低危-4）：`./` 本地 action 隐含「仓库已 checkout」，不得误报缺 checkout。

        原实现把 `./` 当作「没有 actions/checkout@」⇒ 用本地 action + run 脚本被误报。
        """
        text = VALID.replace(
            f"      - uses: actions/checkout@{SHA}\n"
            "        with:\n"
            "          persist-credentials: false\n"
            "      - name: Run\n"
            "        run: python3 scripts/foo.py",
            "      - uses: ./local-action\n"
            "      - name: Run\n"
            "        run: python3 scripts/foo.py",
        )
        self.assertEqual(errs(text), [])

    def test_persist_credentials_at_step_level_is_not_accepted(self):
        # #539 回归：`persist-credentials` 是 `actions/checkout` 的**输入**，必须写在
        # `with:` 块内。误写在 step 层级是无效字段 —— GitHub 会**拒绝解析整个 workflow**
        # （run name 退化为文件路径、`on:` 失效、所有 event 都触发），本地 YAML 解析器却
        # 不报错，只有真推送才暴露。此用例锁死「step 层级不算数」：缺 `with:` 包裹 ⇒ 必报。
        text = VALID.replace(
            f"      - uses: actions/checkout@{SHA}\n"
            "        with:\n"
            "          persist-credentials: false\n",
            f"      - uses: actions/checkout@{SHA}\n"
            "        persist-credentials: false\n",
        )
        self.assert_flagged(text, "缺少 `with: persist-credentials: false`")

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
        uses: actions/checkout@5c48d5b1b0aa30e9a9d3beba20aa9e3e4a2cbc66
        with:
          persist-credentials: false
      - name: Import cert
        if: runner.os == 'macOS'
        env:
          KEY: ${{ secrets.KEY }}
        run: |
          echo hi
"""
        self.assertEqual(errs(text), [])

    def test_list_item_block_scalar_run_is_not_flagged(self):
        """#451：列表项形式的块标量 `- run: |` **不得**误报。

        缺陷形态：`- run: |` 同时满足 `startswith("- ")`，原实现在列表项分支
        提前 `continue`，永远到不了块标量判定 ⇒ 其后每行脚本体都被报
        「不是合法的 key: value 行」。

        `- run: |` 是 GitHub Actions 最常用的写法之一，仓库当前 6 个 workflow
        恰好都没用它，所以这个误报一直潜伏着 —— 合规 PR 的 CI 会直接红。
        """
        text = """\
name: demo

on:
  push:

permissions:
  contents: read

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: |
          echo hello
          echo world
      - uses: actions/checkout@5c48d5b1b0aa30e9a9d3beba20aa9e3e4a2cbc66
        with:
          persist-credentials: false
"""
        self.assertEqual(
            errs(text),
            [],
            "合法的列表项块标量 `- run: |` 必须零误报（#451）",
        )

    def test_list_item_block_scalar_after_name_is_not_flagged(self):
        """#451：`- name:` + 列表项内 `if: |` 的组合也不得误报。

        与 `test_block_scalar_run_is_not_empty_step`（分隔行形式）互补 ——
        那一例的 `run: |` 是独立行、走 `parse_kv` 分支；本例的块标量**在列表项内**，
        走的是原先会提前 `continue` 的那条路径。
        """
        text = """\
name: demo

on:
  push:

permissions:
  contents: read

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@5c48d5b1b0aa30e9a9d3beba20aa9e3e4a2cbc66
        with:
          persist-credentials: false
      - name: Import cert
        run: |
          echo hi
          echo yo
"""
        self.assertEqual(errs(text), [])

    def test_list_item_block_scalar_body_lines_are_not_parsed_as_keys(self):
        """#451 防线：块标量**内部**的行不得被当成 `key: value` 解析。

        脚本体里出现 `- 变量: 值` 这类形态时，若块状态没开，它会被当成
        步骤起始行并触发「空步骤」误报。
        """
        text = """\
name: demo

on:
  push:

permissions:
  contents: read

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@5c48d5b1b0aa30e9a9d3beba20aa9e3e4a2cbc66
        with:
          persist-credentials: false
      - run: |
          echo "- not-a-step: x"
          echo ok
"""
        self.assertEqual(
            errs(text),
            [],
            "块标量内部的 `- key: value` 形态不得被当成新步骤（#451）",
        )

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
      - uses: actions/checkout@5c48d5b1b0aa30e9a9d3beba20aa9e3e4a2cbc66
        with:
          persist-credentials: false
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
        uses: actions/checkout@5c48d5b1b0aa30e9a9d3beba20aa9e3e4a2cbc66
        with:
          persist-credentials: false
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


class LegalShorthandNotFlaggedTest(unittest.TestCase):
    """#329 防误报：几种 GitHub **官方合法**写法此前被误判成缺陷。

    检查器的误报比漏报更致命（每个 PR 的 CI 都会红，最后只能把它从 CI 删掉），
    所以这几种写法必须逐一点到。反向验证：删掉结论里的
    `PERMISSION_SHORTHANDS` / 顶层 `on` 内联分支后，前两个用例立刻失败。
    """

    def test_permissions_read_all_shorthand_is_legal(self):
        text = VALID.replace("permissions:\n  contents: write\n", "permissions: read-all\n")
        self.assertEqual(errs(text), [])

    def test_permissions_write_all_shorthand_is_legal(self):
        text = VALID.replace("permissions:\n  contents: write\n", "permissions: write-all\n")
        self.assertEqual(errs(text), [])

    def test_permissions_inline_map_is_legal(self):
        text = VALID.replace(
            "permissions:\n  contents: write\n", "permissions: {contents: read}\n"
        )
        self.assertEqual(errs(text), [])

    def test_on_inline_array_is_legal(self):
        text = VALID.replace("on:\n  pull_request:\n", "on: [push, pull_request]\n")
        self.assertEqual(errs(text), [])

    def test_on_single_event_scalar_is_legal(self):
        text = VALID.replace("on:\n  pull_request:\n", "on: push\n")
        self.assertEqual(errs(text), [])

    def test_toolchain_channel_ref_is_flagged(self):
        # #539 VULN-01：`dtolnay/rust-toolchain@stable` 虽是官方「通道」写法，但仍是可变引用 ——
        # 上游移动 stable 即换掉 CI 执行的代码。新规一律要求 40 位 SHA，故 `@stable` 必报。
        text = VALID.replace(
            f"- uses: actions/checkout@{SHA}",
            f"- uses: actions/checkout@{SHA}\n      - uses: dtolnay/rust-toolchain@stable",
        )
        problems = errs(text)
        self.assertTrue(
            any("不是完整 commit SHA" in p for p in problems),
            f"`@stable` 应被判为未固定到 commit SHA，实际：{problems}",
        )

    def test_needs_existing_job_is_legal(self):
        text = """\
name: demo

on:
  push:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo build
  deploy:
    runs-on: ubuntu-latest
    needs: build
    steps:
      - run: echo deploy
"""
        self.assertEqual(errs(text), [])

    def test_needs_inline_array_is_legal(self):
        text = """\
name: demo

on:
  push:

jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo a
  b:
    runs-on: ubuntu-latest
    steps:
      - run: echo b
  c:
    runs-on: ubuntu-latest
    needs: [a, b]
    steps:
      - run: echo c
"""
        self.assertEqual(errs(text), [])


class ExtendedDetectionTest(unittest.TestCase):
    """#329 新增判定：四类此前漏报的缺陷必须被标记。"""

    def assert_flagged(self, text: str, needle: str):
        problems = errs(text)
        self.assertTrue(
            any(needle in p for p in problems),
            f"期望出现包含 {needle!r} 的问题，实际：{problems}",
        )

    def test_floating_branch_ref_is_flagged(self):
        # #539 VULN-01：浮动分支 / 版本 tag / 通道**都**不再是合法固定 —— 一律要求 40 位 SHA。
        for ref in ("main", "master", "HEAD", "latest", "v5", "v4.2.2", "stable"):
            with self.subTest(ref=ref):
                text = VALID.replace(
                    f"- uses: actions/checkout@{SHA}",
                    f"- uses: actions/checkout@{ref}",
                )
                self.assert_flagged(text, "不是完整 commit SHA")

    def test_full_sha_ref_is_not_flagged(self):
        # 只有完整 40 位 commit SHA 才算固定（大小写不限）。
        for ref in (SHA, SHA.upper()):
            with self.subTest(ref=ref):
                text = VALID.replace(
                    f"- uses: actions/checkout@{SHA}",
                    f"- uses: actions/checkout@{ref}",
                )
                self.assertEqual(
                    [p for p in errs(text) if "commit SHA" in p],
                    [],
                    f"{ref} 是完整 SHA，不应被判为未固定",
                )

    def test_runs_on_without_steps_is_flagged(self):
        text = VALID.replace("    steps:\n", "")
        self.assert_flagged(text, "没有 `steps:`")

    def test_duplicate_top_level_key_is_flagged(self):
        text = VALID + "\non:\n  push:\n"
        self.assert_flagged(text, "顶层 `on:` 重复声明")

    def test_duplicate_jobs_key_is_flagged(self):
        text = VALID.replace("jobs:\n", "jobs:\n\njobs:\n", 1)
        self.assert_flagged(text, "顶层 `jobs:` 重复声明")

    def test_needs_unknown_job_is_flagged(self):
        text = VALID.replace(
            "    runs-on: ubuntu-latest\n",
            "    runs-on: ubuntu-latest\n    needs: nope\n",
            1,
        )
        self.assert_flagged(text, "指向不存在的 job")

    def test_on_inline_subkey_not_flagged_as_no_trigger(self):
        """#567：`on:` 下内联映射 / 内联数组子键是合法触发事件，不得误报「没有任何触发事件」。

        反向验证：把 `section == "on"` 块的 `if ind == 2:` 改回 `if ind == 2 and rest == "":`
        ⇒ 本用例的①分支变红。
        """
        needle = "没有任何触发事件"
        # ① 内联映射 `push: {branches: [main]}`
        map_text = VALID.replace(
            "on:\n  pull_request:\n",
            "on:\n  push: {branches: [main]}\n",
        )
        self.assertFalse(
            any(needle in p for p in errs(map_text)),
            f"内联映射触发不应被误报，实际：{errs(map_text)}",
        )
        # ② 内联数组 `pull_request: [opened]`
        arr_text = VALID.replace(
            "on:\n  pull_request:\n",
            "on:\n  pull_request: [opened]\n",
        )
        self.assertFalse(
            any(needle in p for p in errs(arr_text)),
            f"内联数组触发不应被误报，实际：{errs(arr_text)}",
        )

    def test_on_block_still_flagged_if_genuinely_empty(self):
        """#567 回归：`on:` 块真的空时仍必须报「没有任何触发事件」。"""
        text = VALID.replace("on:\n  pull_request:\n", "on:\n")
        self.assert_flagged(text, "没有任何触发事件")

    # ── #539 VULN-04：`run` 内 `${{ github.event.* }}` 脚本注入 ──────────────────
    def test_run_interpolation_is_flagged(self):
        """#563：VULN-04 三种形态都必须被拦（独立行 / 块标量 / 列表项内联）。

        反向验证：把 check-workflow-yaml.py 列表项分支的 `run_interpolation_ln`
        调用移除 ⇒ 本用例的「列表项内联」分支变红。
        """
        needle = "攻击者可影响"
        # ① 独立行 `run:`（非列表项）—— 既有分支，防回归。
        indep = VALID.replace(
            "        run: python3 scripts/foo.py",
            '        run: echo "${{ github.event.issue.title }}"',
        )
        self.assert_flagged(indep, needle)
        # ② 块标量 `run: |` —— 既有分支，防回归。
        block = """\
name: demo

on:
  push:

permissions:
  contents: read

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: |
          echo "${{ github.event.issue.title }}"
"""
        self.assert_flagged(block, needle)
        # ③ 列表项内联 `- run: <cmd>` —— #563 修的那条（此前绕过检查）。
        inline = VALID.replace(
            "      - name: Run\n        run: python3 scripts/foo.py",
            '      - run: echo "${{ github.event.issue.title }}"',
        )
        self.assert_flagged(inline, needle)

    def test_run_interpolation_cross_line_split_is_flagged(self):
        """#581（低危-5）：`${{` 与 `github.event` 跨行拆分不得绕过。

        原实现 `RUN_INTERPOLATION_RE` 逐行匹配，`run: |` 块标量里 `${{` 在某行、
        `github.event` 在下一行 ⇒ 两行各自都不含完整模式 ⇒ 绕过（黑盒实跑确认）。
        修法：累积 run 块**完整**文本，块结束时一次性匹配（`[^}]*` 跨 `\\n` 命中）。

        反向验证：把 in_block 分支改回逐行 `run_interpolation_ln` ⇒ 本用例变红
        （跨行拆分恢复绕过，scan 返回 []）。
        """
        needle = "攻击者可影响"
        text = """\
name: demo

on:
  push:

permissions:
  contents: read

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: |
          echo "${{ 
            github.event.issue.title }}"
"""
        self.assert_flagged(text, needle)
        # 跨行拆分 `github.ref_name` 同样要拦。
        text2 = text.replace(
            "echo \"${{ \n            github.event.issue.title }}\"",
            "echo \"${{ \n            github.ref_name }}\"",
        )
        self.assert_flagged(text2, needle)

    def test_run_interpolation_allowed_contexts_not_flagged(self):
        """#539 VULN-04 边界：运营方 / GitHub 控制的 context 不在禁止之列，不得误报。"""
        allowed = [
            "${{ secrets.KEY }}",
            "${{ github.sha }}",
            "${{ github.token }}",
            "${{ env.VAR }}",
            "${{ matrix.os }}",
            "${{ runner.os }}",
        ]
        for ctx in allowed:
            with self.subTest(ctx=ctx):
                text = VALID.replace(
                    "        run: python3 scripts/foo.py",
                    f"        run: echo \"{ctx}\"",
                )
                problems = errs(text)
                self.assertNotIn(
                    "攻击者可影响",
                    [p for p in problems if "内插" in p or "注入" in p],
                    f"{ctx} 不应被 VULN-04 拦下，实际：{problems}",
                )


if __name__ == "__main__":
    unittest.main()
