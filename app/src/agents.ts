/**
 * 主流 coding agent 列表（#177 起由 DetailPanel 与 SettingsPanel 共用，单一来源）。
 *
 * - value 为规范化 slug（与 MCP/agent 自报名一致，便于存储与展示统一），
 *   同时直接作为 hooks 安装器的 agent id（一键安装覆盖 HOOK_SUPPORTED_AGENTS）。
 * - label 为默认展示名；部分国内 agent 的 label 含中文，经 i18nKey 接入 i18n。
 */

// 一键安装/卸载已验证 hook 机制的 agent（后端 hooks.rs 注册表与此保持一致）。
export const HOOK_SUPPORTED_AGENTS: readonly string[] = [
  "claude-code",
  "opencode",
  "workbuddy",
  "codebuddy",
  "trae",
];

// 未验证一键安装的 agent 的手动配置指路（后端 notice 是权威版，此处仅行内提示用）。
export const MANUAL_PATH_HINTS: Readonly<Record<string, string>> = {
  codex: "~/.codex/hooks.json",
  cursor: "~/.cursor/hooks.json",
  copilot: "~/.copilot/hooks/hooks.json",
  "gemini-cli": "~/.gemini/settings.json",
  "qwen-code": "~/.qwen/settings.json",
  kimi: "~/.kimi/config.toml",
  zcode: "~/.zcode/cli/config.json",
};

export type AgentOption = { value: string; label: string; i18nKey?: string };

export const AGENTS: AgentOption[] = [
  { value: "amazon-q", label: "Amazon Q" },
  { value: "augment", label: "Augment Code" },
  { value: "bolt", label: "Bolt.new" },
  { value: "chatgpt", label: "ChatGPT" },
  { value: "claude-code", label: "Claude Code" },
  { value: "cline", label: "Cline" },
  { value: "codebuddy", label: "CodeBuddy" },
  { value: "codeium", label: "Codeium" },
  { value: "codex", label: "Codex (OpenAI)" },
  { value: "codestral", label: "Codestral" },
  { value: "cody", label: "Sourcegraph Cody" },
  { value: "continue", label: "Continue" },
  { value: "copilot", label: "GitHub Copilot" },
  { value: "cursor", label: "Cursor" },
  { value: "deepseek", label: "DeepSeek" },
  { value: "devin", label: "Devin" },
  { value: "doubao", label: "豆包 (Doubao)", i18nKey: "agents.doubao" },
  { value: "factory", label: "Factory Droid" },
  { value: "gemini-cli", label: "Gemini CLI" },
  { value: "glm", label: "智谱 GLM", i18nKey: "agents.glm" },
  { value: "goose", label: "Goose" },
  { value: "grok", label: "Grok (xAI)" },
  { value: "helix", label: "Helix CLI" },
  { value: "kimi", label: "Kimi" },
  { value: "llama", label: "Llama (Meta)" },
  { value: "opencode", label: "OpenCode" },
  { value: "openhands", label: "OpenHands" },
  { value: "phind", label: "Phind" },
  { value: "qwen-code", label: "Qwen Code" },
  { value: "replit", label: "Replit Agent" },
  { value: "roo-code", label: "Roo Code" },
  { value: "tabnine", label: "Tabnine" },
  { value: "tongyi", label: "通义灵码", i18nKey: "agents.tongyi" },
  { value: "trae", label: "Trae" },
  { value: "v0", label: "Vercel v0" },
  { value: "windsurf", label: "Windsurf" },
  { value: "workbuddy", label: "WorkBuddy" },
  { value: "zcode", label: "ZCode" },
  { value: "aider", label: "Aider" },
];

// 取 agent 的显示名：带 i18nKey 的走 i18n，其余用默认 label；未知 slug 原样返回。
export const agentLabel = (
  value: string,
  t: (k: string, p?: Record<string, string | number>) => string,
): string => {
  const a = AGENTS.find((x) => x.value === value);
  if (!a) return value;
  return a.i18nKey ? t(a.i18nKey) : a.label;
};
