# 安全策略

## 支持的版本

| 版本 | 支持状态 |
|------|----------|
| 最新版本 | ✅ 支持 |
| 之前的版本 | ❌ 不支持 |

## 报告漏洞

如果你发现安全漏洞，请**不要**在公开的 GitHub issue 中报告。

请通过以下方式报告：

1. **GitHub Security Advisories**: 使用 [GitHub 的私有漏洞报告功能](https://github.com/ShawnLiuSZ/task-dashboard/security/advisories/new)

2. **邮件**: 发送邮件至项目维护者（如果可用）

请提供以下信息：
- 漏洞的描述
- 复现步骤
- 可能的影响
- 建议的修复方案（如果有）

## 安全考虑

### 数据存储

- TaskBoard 将所有数据存储在本地 SQLite 数据库中
- GitHub Personal Access Token (PAT) 存储在本地
- **绝不会**将敏感数据上传到外部服务器

### 网络通信

- 仅与 GitHub API (api.github.com) 通信
- 所有通信使用 HTTPS
- 不发送遥测数据

### 权限

TaskBoard 请求的最小权限：
- `repo`: 读取仓库和 issue 信息
- `project`: 读取 Project 信息

### 最佳实践

1. **保护你的 PAT**: 不要分享你的 GitHub Personal Access Token
2. **定期轮换 PAT**: 建议定期更新你的 PAT
3. **使用细粒度权限**: 仅授予必要的最小权限
4. **本地存储**: 数据仅存储在你的本地设备上

## 更新

安全更新将通过以下方式通知：
- GitHub Release Notes
- 应用内更新提示

## 合规

- 本项目不收集任何用户数据
- 所有数据处理均在本地完成
- 符合 GDPR 数据最小化原则
