# #478 应用内更新不可用：updater 清单缺 macOS 平台条目

> 对应 issue：[#478](https://github.com/ShawnLiuSZ/task-dashboard/issues/478)
> 分支：`fix/lsz/updater-manifest-macos`
> 影响面：`release.yml`（矩阵串行化 + 门禁 job）、`scripts/check-updater-manifest.py`（新增）

## 一、现象

macOS 上「应用内更新」直接失败：

```
检查更新失败：None of the fallback platforms `["darwin-aarch64-app", "darwin-aarch64"]`
were found in the response `platforms` object
```

Windows / Linux 正常。**根因不在客户端** —— 发布出去的 `latest.json` 里
**一个 macOS 条目都没有**。

## 二、根因

### 2.1 现象侧

实测 v0.7.7 线上清单：14 个 key **全是 Linux / Windows**，缺
`darwin-aarch64` / `darwin-aarch64-app` / `darwin-x86_64` / `darwin-x86_64-app`。

而 macOS 的 updater 产物**其实都在 Release 上**
（`TaskBoard_0.7.7_aarch64.app.tar.gz` 及其 `.sig`）⇒ 纯粹是**清单漏了**。

### 2.2 机制侧：tauri-action v1 的并发竞态

`tauri-apps/tauri-action@v1` 的 `uploadVersionJSON()`（`src/upload-version-json.ts`）
在**每个矩阵 job 结束时各跑一次**，每次都是：

1. 下载 Release 上已有的 `latest.json`（没有就当空）；
2. 合并**自己这个平台**的条目；
3. **删掉旧资产**（GitHub 的 release 资产**不能同名覆盖**，必须先删）；
4. 上传新的。

`release.yml` 的 6 个矩阵 job **并发**跑 ⇒ 删/传互相踩：后完成的 job 常常拿着
**过期**的清单内容去覆盖 ⇒ **先完成平台的条目整块丢失**。

实测 v0.7.7 的时序（release run `39897134533`）：

| 时刻 | job | 动作 | 清单里剩下什么 |
|---|---|---|---|
| 03:53:06 | macOS x64 | 传清单 | darwin-x86_64 |
| 03:55:55 | macOS aarch64 | 传清单 | darwin-x64 + darwin-arm64 |
| 03:55:55 | **ubuntu x64** | **删除已有清单** → 传自己的 | **macOS 条目被抹掉** |
| 03:56:25 | ubuntu arm64 | 传清单 | + linux-aarch64 |
| 03:58:43 | windows arm64 | 传清单 | + windows-aarch64 |
| 03:58:50 | windows x64 | 传清单 | + windows-x86_64（**最终产物**） |

⇒ 最终清单 = Linux + Windows，**macOS 蒸发**。

⚠️ 竞态的受害方取决于**谁先完成** ⇒ 每次可能不同（本次是 macOS，因为它的两个
job 最早完成）⇒ 表现为「时好时坏」。

## 三、修法（两层）

### 3.1 根因：矩阵串行化

`release.yml` 的 build job 加 `max-parallel: 1` ⇒ 每个 job 都能看到前一个 job 的
清单 ⇒ 最终清单必然齐全。

- **用上游自己的清单逻辑**，不重复实现 key 规则 ⇒ 不会与 tauri-action 漂移；
- 代价：发版从约 9 分钟变成约 **45~50 分钟**（构建本身不变，只是排队）。

### 3.2 兜底：清单完整性门禁

新增 `scripts/check-updater-manifest.py`（零第三方依赖）+ workflow 里的
`updater-check` job（`needs: build`）⇒ 矩阵跑完后复核**线上**清单，
缺平台条目就**让发版变红**，而不是静默发一个装不了更新的版本。

校验内容（`PLATFORM_BUNDLES` 是「这个版本应该有哪些条目」的唯一事实来源，
与 `release.yml` 的矩阵一一对应）：

| # | 断言 |
|---|---|
| 1 | 6 个平台的 primary key（`{os}-{arch}`）+ 各 bundle 变体都在（共 18 个） |
| 2 | 每个条目的 `signature` / `url` 非空 |
| 3 | 清单 `version` 与 tag 对得上（`v0.7.7` ⇒ `0.7.7`） |

两种用法：

```bash
python3 scripts/check-updater-manifest.py --file latest.json   # 离线
python3 scripts/check-updater-manifest.py --tag v0.7.7          # 在线（需 GITHUB_TOKEN）
```

## 四、v0.7.7 的即时修复

已本地补齐 4 个 macOS 条目（从 Release 下载对应 `.app.tar.gz` 的 `.sig` 内容 +
资产 URL）并替换线上清单 ⇒ 清单从 14 个 key 变成 **18 个** ⇒
**macOS 应用内更新恢复可用**。

> ⚠️ `gh release upload` 的 `file#label` 语法设的是**显示标签**、不是文件名 ⇒
> 必须把本地文件**重命名为 `latest.json`**再传（否则会被传成 `xxx.json`）。

## 五、测试 / 验收

| # | 标准 | 验证方式 |
|---|---|---|
| 1 | 完整清单通过 | `test_complete_manifest_passes` |
| 2 | 缺 macOS 条目被检出（v0.7.7 的真实故障形态） | `test_missing_darwin_keys_are_reported` |
| 3 | 缺单个 bundle 变体被检出 | `test_missing_one_bundle_variant_is_reported` |
| 4 | `signature` / `url` 为空被检出 | `test_empty_signature_is_reported` / `test_empty_url_is_reported` |
| 5 | version 与 tag 对不上被检出 | `test_version_mismatch_with_tag_is_reported` |
| 6 | 期望 key 集合 = 18（与线上实测一致） | `test_expected_key_count_is_18` |
| 7 | **反向验证**：把线上清单删掉 macOS 条目 ⇒ 校验器 exit 1 | 实测 ✓ |

## 六、相关链接

- Issue：[#478](https://github.com/ShawnLiuSZ/task-dashboard/issues/478)
- 校验脚本：`scripts/check-updater-manifest.py`（单测 `scripts/test_check_updater_manifest.py`）
- 发版流程：见 [`docs/issue-231-macos-gatekeeper-update.md`](./issue-231-macos-gatekeeper-update.md)
- CHANGELOG：[`CHANGELOG.md`](./CHANGELOG.md) / [`CHANGELOG.en.md`](./CHANGELOG.en.md)
