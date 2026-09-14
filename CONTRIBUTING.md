# 贡献指南

感谢你对 TaskBoard 的关注！本文档将帮助你快速上手贡献代码。

## 开发环境

### 前置要求

- [Node.js](https://nodejs.org/) 22+
- [Rust](https://www.rust-lang.org/tools/install) stable
- [Tauri CLI](https://v2.tauri.app/start/prerequisites/)

### 安装依赖

```bash
cd app
npm install
```

### 启动开发服务器

```bash
cd app
npm run tauri dev
```

## 代码规范

### Rust

- 使用 `cargo clippy` 检查代码质量
- 使用 `cargo fmt` 格式化代码
- 所有公共 API 需要文档注释

### TypeScript/React

- 使用 ESLint 和 Prettier 格式化代码
- 运行 `npm run lint` 检查代码质量
- 运行 `npm run format` 格式化代码

### 提交规范

提交信息使用中文，格式为：`类型(范围): 简述`

类型：
- `feat`: 新功能
- `fix`: 修复 bug
- `docs`: 文档更新
- `style`: 代码格式（不影响功能）
- `refactor`: 重构
- `test`: 测试相关
- `chore`: 构建/工具相关

示例：
```
feat(mcp): 新增 clear_session 工具
fix(sync): 修复同步日志时间显示错误
docs: 更新 README 安装说明
```

## 分支管理

- `main`: 稳定版本
- `develop`: 开发分支
- `feature/*`: 功能分支
- `fix/*`: 修复分支

所有改动必须通过 PR 合入，禁止直接推送到 `main` 或 `develop`。

## 测试

### Rust 测试

```bash
cd app/src-tauri
cargo test --lib
cargo test --test db_test
```

### 前端测试

```bash
cd app
npm test
```

### 质量检查

```bash
# MCP 列名一致性
python3 scripts/check-mcp-columns.py

# 文档链接完整性
python3 scripts/check-doc-links.py

# i18n 一致性
cd app && npm run i18n:check
```

## 文档

- 每个功能或修复都需要在 `docs/` 目录下添加对应的文档
- 文档命名格式：`issue-{编号}-{简述}.md` 或 `v{版本}-{功能}.md`
- 文档必须包含：背景/动机、设计/方案、接口/行为变更、测试/验收、相关链接

## 获取帮助

- 查看 [README.md](./README.md) 了解项目概述
- 查看 [PRD.md](./PRD.md) 了解产品需求
- 查看 [docs/](./docs/) 目录下的设计文档
