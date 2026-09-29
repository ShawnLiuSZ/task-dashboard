/**
 * #325：从 `navigator.userAgent` 推导系统 WebView 引擎版本。
 *
 * 取舍：Tauri 2 核心不暴露 WebView 版本 API，且项目约定（AGENTS.md §2.5）不引入新依赖
 * （官方 `tauri-plugin-webview-version` 即为此而生）。系统 WebView（macOS 的 WKWebView /
 * Windows 的 WebView2 / Linux 的 WebKitGTK）即 Tauri 实际使用的渲染引擎，故直接读其
 * userAgent。Rust 命令 `get_runtime_info` 只回传 app / tauri 版本，此函数补齐第三行。
 */
export function getWebviewVersion(): string {
  const ua = navigator.userAgent;
  const gtk = ua.match(/WebKitGTK\/([\d.]+)/);
  if (gtk) return `WebKitGTK ${gtk[1]}`;
  const edg = ua.match(/\bEdg\/([\d.]+)/);
  if (edg) return `WebView2 ${edg[1]}`;
  const chrome = ua.match(/\bChrome\/([\d.]+)/);
  if (chrome) return `Chromium ${chrome[1]}`;
  const wk = ua.match(/AppleWebKit\/([\d.]+)/);
  if (wk) return `WebKit ${wk[1]}`;
  const ver = ua.match(/Version\/([\d.]+)/);
  if (ver) return `WebKit ${ver[1]}`;
  return '';
}
