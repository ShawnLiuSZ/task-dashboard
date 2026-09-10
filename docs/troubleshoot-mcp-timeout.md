# MCP 连接超时（30000ms）排障 —— macOS Gatekeeper / quarantine

> 通用知识条目。适用于「把 TaskBoard MCP server 接入 Claude Code / WorkBuddy / Codex 等客户端后，连接或重连提示 `connection timed out after 30000ms`」的问题。
> 关联：[Issue #87](https://github.com/ShawnLiuSZ/task-dashboard/issues/87)。

## 背景 / 动机

内置 MCP server 以 stdio 方式被客户端拉起（`/Applications/TaskBoard.app/Contents/MacOS/taskboard` + `args:["mcp"]`）。连接/重连时报：

```
Failed to reconnect to taskboard: MCP server taskboard connection timed out after 30000ms
```

即客户端 30 秒内未等到握手（initialize）完成。先别急着改 server 代码——**多数情况下 server 本身握手极快，根因在 macOS 签名 / quarantine 或客户端配置**。

## 排查步骤（按顺序）

### 1. 实测 server 握手耗时（排除 server 内因）

对目标二进制发一条 `initialize` 测响应 RTT：

```bash
python3 -c "
import subprocess,json,time
def f(o):
    d=json.dumps(o,separators=(',',':')).encode(); return b'Content-Length: %d\r\n\r\n%s'%(len(d),d)
p=subprocess.Popen(['<BIN>','mcp'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env={'TASKBOARD_DB':'/tmp/tb_probe.db','PATH':'/usr/bin:/bin'})
t0=time.time()
p.stdin.write(f({'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2024-11-05','capabilities':{},'clientInfo':{'name':'p','version':'1'}}})); p.stdin.flush()
b=b''
while b'\r\n\r\n' not in b:
    c=p.stdout.read(1)
    if not c: break
    b+=c
cl=0
for ln in b.decode(errors='replace').split('\r\n'):
    k,_,v=ln.partition(':')
    if k.strip().lower()=='content-length': cl=int(v.strip())
print('RTT=%dms %s'%(round((time.time()-t0)*1000), json.loads(p.stdout.read(cl))['result']['serverInfo'])); p.kill()
"
```

实测参考（Issue #87）：

| 二进制 | 版本 | initialize RTT |
|---|---|---|
| 源码 debug 构建 | 0.3.39 | ~1.6s（含首次 DB 全量迁移） |
| 已安装 `/Applications` App | 0.3.24 | ~15ms |

结论：server 握手远低于 30s，**不是 server 慢导致超时**。

### 2. 检查签名与隔离属性（macOS 高概率根因）

```bash
codesign -dv --verbose=2 "/Applications/TaskBoard.app"   # 看 Signature / TeamIdentifier
spctl -a -vv "/Applications/TaskBoard.app"               # rejected = 被 Gatekeeper 拒绝
xattr -l "/Applications/TaskBoard.app"                   # 是否带 com.apple.quarantine
```

判定：若 **`Signature=adhoc`（无 Developer ID）** 且 **带 `com.apple.quarantine`**（多为 Safari 下载/finder 解压产生），则位于 `/Applications` 的 App 会被 Gatekeeper 判定不可信，作用于首启 / LaunchServices 的检查会显著拖慢甚至拦截进程，客户端 30s 窗口内等不到握手而报超时。

### 3. 修复（无需签名证书，本机自用）

**优先：App 首启自动清除（v0.3.44+）。** 只要用 GUI 打开过一次 TaskBoard（首次会让你放行一次，属系统强制行为），App 会在启动时
检测并自动 `xattr -dr` 清除自身 bundle 的 quarantine——**无需 sudo、无需手动命令**。规则：一次 GUI 放行 + 自动清除 = 永久可用。
见 [issue-101-quarantine-autoclear.md](./issue-101-quarantine-autoclear.md)。

若 App 完全打不开（被 Gatekeeper 硬拦、进不了首启逻辑），才需要手动 fallback：

```bash
sudo xattr -dr com.apple.quarantine "/Applications/TaskBoard.app"
```

验证：

```bash
xattr -l "/Applications/TaskBoard.app"          # 不再出现 quarantine
xattr -l "/Applications/TaskBoard.app/Contents/MacOS/taskboard"
```

然后完全退出并重启客户端（WorkBuddy / Claude Code）重连。

> 说明：清除后 `spctl` 仍可能显示 `rejected`（因为本就没有公证签名），但 Gatekeeper 的拦截主要依赖 quarantine 标记，移除后即正常启动、不再超时。

### 4. 其它候选（排除后）再考虑

- **版本落后**：确认 `/Applications` 里的 App 版本与代码一致（Issue #87 中已装的是 0.3.24，远落后）。
- **客户端 MCP 配置**：`~/.workbuddy/mcp.json`（或 client 的 `.mcp.json`）的 `type: stdio`、`command`、`args:["mcp"]` 是否与目标二进制匹配。
- **便携兜底对比**：用 `mcp_server/server.py` 同机对比握手，排除内置 server 特有行为。

## 接口 / 行为变更

- v0.3.44+：新增 macOS 启动期自动清除自身 quarantine 逻辑（`taskboard` 主二进制的 `com.apple.quarantine`），无需手动 sudo；无外部 API / MCP 工具变更。见 [issue-101-quarantine-autoclear.md](./issue-101-quarantine-autoclear.md)。
- 此前的方案（手动 `sudo xattr -dr`）保留为「App 完全打不开」时的 fallback。

## 数据 / Schema 变更

无。

## 测试 / 验收

- 清除 quarantine 后 `xattr -l` 不再显示该属性。
- 客户端重连 MCP，工具列表可被发现并调用（`update_task_status` / `get_task_status` 等正常返回）。
- 连续多次会话连接稳定，不再出现 `connection timed out`。

## 相关链接

- [Issue #87](https://github.com/ShawnLiuSZ/task-dashboard/issues/87)（诊断评论：issuecomment-5564810715、issuecomment-5564841800）
- [Issue #101](https://github.com/ShawnLiuSZ/task-dashboard/issues/101)（自动清除）
- [docs/CHANGELOG.md](./CHANGELOG.md)
- MCP 工具契约：[mcp_server/AGENT_INSTRUCTIONS.md](../mcp_server/AGENT_INSTRUCTIONS.md)