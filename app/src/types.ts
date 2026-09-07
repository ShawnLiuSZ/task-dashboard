export type StatusKey = "todo" | "doing" | "processed" | "done";
export type Ownership = "assigned" | "notassignee" | "assigned-others";
/** v0.3.16+：视图模式。`single`=仅显示激活账号任务；`all`=显示所有账号任务。 */
export type ViewMode = "single" | "all";
/** v0.3.21+：看板列模式。`status`=四态列；`project`=GitHub Project Status 列。 */
export type BoardMode = "status" | "project" | "custom";

export interface Account {
  id: number;
  label: string;
  login: string;
  org: string;
  /** 是否已配置 PAT（不回显 token 本体）。 */
  hasPat: boolean;
  isDefault: boolean;
  createdAt: number;
}

/** v0.3.22+：GitHub Project v2 记录（sync 时自动发现并存入 projects 表）。 */
export interface Project {
  id: number;
  accountId: number;
  githubId: string;
  name: string;
  numberOfItems: number;
  /** "user" 或 "org"。 */
  ownerType: string;
  createdAt: number;
}

/** v0.3.22+：项目 Status 字段选项（sync 时从 GraphQL 读取，用于看板列排序）。 */
export interface ProjectStatus {
  id: number;
  accountId: number;
  projectGithubId: string;
  name: string;
  orderIndex: number;
}

export interface Task {
  key: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  ghState: string;
  ownership: Ownership;
  status: StatusKey;
  ghStatus: string;
  assignees: string;
  mentioned: boolean;
  latestCommentUrl: string;
  prNumber: number;
  prUrl: string;
  branch: string;
  sessionId: string | null;
  sessionAgent: string | null;
  sessionAt: number | null;
  candidateDone: boolean;
  handoff: string;
  updatedAt: string | null;
  /** v0.3.16+：归属账号 id（指向 accounts.id）。 */
  accountId: number;
}

export interface SyncResult {
  total: number;
  added: number;
  updated: number;
  candidateDone: number;
  removed: number;
  pruned: number;
  warning: string;
  syncedAt: number;
}

export interface Settings {
  scheduleMinutes: number;
  /** 历史字段：保留兼容（v0.3.15 起不再用于任何路径，仅显示）。 */
  ghPath: string;
  login: string;
  org: string;
  lastSyncAt: number;
  dbPath: string;
  /** v0.3.15+：是否已配置 PAT（不回显 token 本体）。 */
  hasPat: boolean;
  /** v0.3.15+：最近一次同步的错误信息，用作 banner 展示。 */
  lastSyncError: string;
  /** v0.3.16+：当前激活账号 id（单账号视图下同步此账号）。 */
  activeAccountId: number;
  /** v0.3.16+：视图模式。 */
  viewMode: ViewMode;
  /** v0.3.21+：看板列模式。status=四态列，project=Project 状态列。 */
  boardMode: BoardMode;
  /** v0.3.16+：所有账号列表（不含 PAT 本体）。 */
  accounts: Account[];
  /** v0.3.17+：GitHub OAuth Device Flow 的 client_id（注册 OAuth App 后填一次）。 */
  oauthClientId: string;
}

/** v0.3.15+：`save_pat` / `test_pat` 命令的返回值。 */
export interface PatStatus {
  login: string;
  hasPat: boolean;
}

/** v0.3.17+：Device Flow 第 1 步返回（申请设备码成功）。 */
export interface DeviceLoginStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  /** 已预填 user_code 的完整 URL；直接打开可免手动输码。 */
  verificationUriComplete: string;
  /** user_code 有效期（秒），通常 900。 */
  expiresIn: number;
  /** 建议轮询间隔（秒），通常 5。 */
  interval: number;
}

/** v0.3.17+：Device Flow 第 2 步单次轮询结果。 */
export interface DeviceLoginPoll {
  /** pending | slow_down | success | error */
  status: "pending" | "slow_down" | "success" | "error";
  /** 成功时填：授权账号的 GitHub login。 */
  login: string;
  /** 成功时填：新建/更新的账号 id。 */
  accountId: number;
  /** 提示或错误信息。 */
  message: string;
}

/** v0.3.19+：「检查更新」命令返回值。 */
export interface CheckUpdate {
  /** 当前版本（来自后端 Cargo 包版本）。 */
  current: string;
  /** GitHub 最新 release 版本号（去 `v` 前缀）。 */
  latest: string;
  /** 当前是否已是最新。 */
  upToDate: boolean;
  /** 最新 release 页面地址。 */
  url: string;
  /** 非空表示检查失败。 */
  error: string;
}

/** v0.3.20+：Label→Status 映射。 */
export interface LabelMapping {
  id: number;
  org: string;
  repo: string;
  label: string;
  status: StatusKey;
  orderIndex: number;
  createdAt: number;
  updatedAt: number;
}

/** v0.3.20+：Label→Status 映射输入（新增/编辑）。 */
export interface LabelMappingInput {
  org: string;
  repo: string;
  label: string;
  status: StatusKey;
  orderIndex: number;
}

/** v0.3.21+：Label 列视图的列配置（含兜底「未标记」列）。 */
export interface LabelColumnConfig {
  /** 列唯一标识：label 名称，或 "unlabeled" 表示兜底列。 */
  key: string;
  /** 列标题（label 名称或 "未标记"）。 */
  title: string;
  /** 对应的 LabelMapping（兜底列无）。 */
  mapping?: LabelMapping;
}

/** v0.3.23+：同步日志记录。 */
export interface SyncLog {
  id: number;
  accountId: number;
  triggerType: string;
  startedAt: number;
  finishedAt: number;
  status: string;
  added: number;
  updated: number;
  removed: number;
  candidateDone: number;
  pruned: number;
  failedSources: string;
  errorMessage: string;
  createdAt: number;
}

/** v0.3.24+：记事本记录。 */
export interface Note {
  id: number;
  content: string;
  label: "low" | "medium" | "high" | "urgent";
  createdAt: number;
  updatedAt: number;
}

/** v0.3.28+：自定义列映射（按账号配置看板列）。 */
export interface AccountColumn {
  id: number;
  accountId: number;
  colKey: string;
  colName: string;
  /** JSON 数组字符串，如 `["待开发","需求","规划"]` */
  matchRules: string;
  orderIndex: number;
}

/** v0.3.28+：自定义列配置输入（编辑时用）。 */
export interface AccountColumnInput {
  colKey: string;
  colName: string;
  /** JSON 数组字符串，如 `["待开发","需求","规划"]` */
  matchRules: string;
  orderIndex: number;
}

/**
 * 四态列定义。label / hint 走 i18n：status.{key} / hint.{key}
 * （Issue #7 起不再硬编码中文文案）。
 */
export const COLUMNS: { key: StatusKey }[] = [
  { key: "todo" },
  { key: "doing" },
  { key: "processed" },
  { key: "done" },
];
