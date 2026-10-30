export type StatusKey = 'todo' | 'doing' | 'processed' | 'done';
export type Ownership = 'assigned' | 'notassignee' | 'assigned-others';
/** v0.3.16+：视图模式。`single`=仅显示激活账号任务；`all`=显示所有账号任务。 */
export type ViewMode = 'single' | 'all';
/** v0.3.21+：看板列模式。`status`=四态列；`project`=GitHub Project Status 列。 */
export type BoardMode = 'status' | 'project' | 'custom';

export interface Account {
  id: number;
  label: string;
  login: string;
  org: string;
  /** 是否已配置 PAT（不回显 token 本体）。 */
  hasPat: boolean;
  isDefault: boolean;
  /** v0.3.43+：该账号的看板列展示方式（status/project/custom），未配置默认 project。 */
  boardMode: BoardMode;
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

/** #278：关联 issue 的父/子链接（GitHub `parent` / `subIssues`，只读同步）。 */
export interface IssueLink {
  number: number;
  title: string;
  url: string;
}

/** #467：一个 issue 关联的**一个** PR（同一 issue 可关联多个 PR）。 */
export interface PrRef {
  number: number;
  url: string;
  /** PR 合并状态 `'merged'` / `'open'` / `'closed'`；空串 = 未知（不显示徽章）。 */
  state: string;
}

/**
 * #472：一条 issue **评论**的链接（同一 issue 可有多条评论）。
 *
 * ⚠️ **不挂在 `Task` 上**：评论可达 100 条/issue，看板一次渲染几百张卡 ⇒
 * 随 `list_tasks` 一起返回会撑爆 IPC 载荷与前端内存。故由
 * `api.listTaskComments(issueKey, accountId)` **按需**取回。
 */
export interface TaskComment {
  /** GitHub 评论 id（稳定标识）。 */
  id: number;
  /** 评论永久链接 —— 跳转目标。 */
  url: string;
  /** 评论作者 login（不含 @）；空串 = 未知。 */
  author: string;
  /** 创建时间（Unix 秒）；0 = 未知。 */
  createdAt: number;
}

/**
 * #490：关联 PR 的提交历史条目（实时拉取，不落库）。
 */
export interface LivePrCommit {
  /** commit sha 前 8 位（展示用）。 */
  sha: string;
  /** 提交信息（首行）。 */
  message: string;
  /** 提交人（commit.author.name 或 author.login）。 */
  author: string;
  /** 提交时间（Unix 秒）；0 = 未知。 */
  date: number;
}

/**
 * #490：实时拉取的 issue 详情（只读 GitHub，不落库）。
 */
export interface LiveIssue {
  number: number;
  title: string;
  url: string;
  /** open / closed（已归一化为小写）。 */
  state: string;
  assignees: string[];
  labels: string[];
  /** issue 创建人 login（不含 @）。 */
  author: string;
  commentsCount: number;
  /** #498：issue 正文（markdown 源文本）；空串 = 无正文。 */
  body: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * #490：`fetchTaskDetailLive` 的返回结构。
 * `comments` 形状与 `TaskComment` 一致，前端可直接喂给评论列表。
 */
export interface LiveTaskDetail {
  issue: LiveIssue;
  comments: TaskComment[];
  prCommits: LivePrCommit[];
  /**
   * #506：Activity 时间线（评论 + 事件交织，按时间升序）。
   *
   * 对齐 orca 的 issue 详情 Activity 区块：一次 Timeline API 请求同时拿到
   * 评论（带正文）与时间线事件（指派 / 标签 / 状态变更 / 交叉引用 / 项目列移动）。
   */
  timeline: LiveTimelineItem[];
}

/**
 * #506：Activity 时间线的一个条目（评论 or 事件）。
 */
export interface LiveTimelineItem {
  /** `comment`（评论正文）/ `event`（时间线事件）。 */
  kind: string;
  /** GitHub 事件名（`commented` / `assigned` / `labeled` / `closed` …）。 */
  event: string;
  /** 操作者 login（不含 @）；空串 = 未知。 */
  actor: string;
  /** 发生时间（Unix 秒）。 */
  createdAt: number;
  /** 评论正文（仅 `kind === 'comment'`）。 */
  body: string;
  /** 评论永久链接（仅 `kind === 'comment'`）。 */
  url: string;
  /** 标签事件的标签名。 */
  label: string;
  /** 指派事件的被指派人 login。 */
  assignee: string;
  /** 交叉引用 / 子 issue 事件指向的目标（如 `fad-backend#1629`）。 */
  refIssue: string;
  /** 里程碑事件的里程碑标题（`milestoned` / `demilestoned`）。 */
  milestone: string;
  /** 审查请求事件的**被请求审查者** login（`review_requested`）。 */
  requestedReviewer: string;
  /** 被引用的**提交** SHA（`referenced`）。 */
  commitSha: string;
}

export interface Task {
  issueKey: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  issueState: string;
  ownership: Ownership;
  status: StatusKey;
  projectStatus: string;
  assignees: string;
  /** #237：issue 创建人（GitHub author login，不含 @）；空表示未知。 */
  author: string;
  mentioned: boolean;
  latestCommentUrl: string;
  prNumber: number;
  prUrl: string;
  /** #435：PR 合并状态 `'merged'` / `'open'` / `'closed'`；空串 = 未知（不显示徽章）。 */
  prState: string;
  /**
   * #467：该 issue 关联的**全部** PR（含主 PR）。
   *
   * `prNumber` / `prUrl` / `prState` 三者是「主 PR」（列表首元素），保留是为了
   * 不破坏既有契约；本数组承载完整的一对多关系，UI 应优先读它。
   * 无关联 PR 时为空数组。
   */
  prs: PrRef[];
  branch: string;
  /** #193：agent 工作分支（record_session 写入，与同步的 PR branch 分离）。 */
  workBranch: string;
  /** #287：agent 工作目录（record_session 写入的项目路径）。 */
  workDir: string;
  /** #278：父 issue；无父为 null。 */
  parentIssue: IssueLink | null;
  /** #278：子 issue 列表；无子为空数组。 */
  subIssues: IssueLink[];
  sessionId: string | null;
  sessionAgent: string | null;
  sessionAt: number | null;
  candidateDone: boolean;
  handoff: string;
  updatedAt: number | null;
  /** #280：issue 创建时间（秒级时间戳，0 表示未知）。 */
  createdAt: number;
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
  /** #262：本次同步覆盖的账号数（可观测性）。 */
  accountsSynced: number;
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
  /** v0.3.16+：所有账号列表（不含 PAT 本体）。每个账号带各自的 boardMode（v0.3.43+）。 */
  accounts: Account[];
  /** v0.3.17+：GitHub OAuth Device Flow 的 client_id（注册 OAuth App 后填一次）。 */
  oauthClientId: string;
  /** v0.6.1 (#276)：每日自动检查更新。 */
  autoCheckUpdates: boolean;
  /** v0.6.1 (#276)：自动更新（静默下载 + 重启）。 */
  autoUpdate: boolean;
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
  status: 'pending' | 'slow_down' | 'success' | 'error';
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

/** #231：应用内更新检查结果（走 tauri-plugin-updater 通道，不依赖 GitHub API）。 */
export interface AppUpdate {
  /** 是否有可一键安装的更新。 */
  available: boolean;
  /** 远端最新版本号（无更新时为空）。 */
  version: string;
  /** 当前版本号。 */
  current: string;
  /** 更新说明（release notes，可能为空）。 */
  notes: string;
  /** 非空表示检查失败，前端据此回退到「前往下载」。 */
  error: string;
}

/** #231：更新下载进度事件负载。 */
export interface UpdateProgress {
  /** 已下载字节数。 */
  downloaded: number;
  /** 总字节数（服务器未提供 Content-Length 时为 null）。 */
  total: number | null;
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

/** v0.3.22+：Project Status 诊断返回（后端 snake_case 原样）。 */
export interface DiagnosedProject {
  github_id: string;
  name: string;
  number_of_items: number;
  owner_type: string;
  fields: string[];
}

/** v0.3.49 (#148)：`diagnose_project_status` 命令返回值，替代此前的 `any`。 */
export interface DiagnoseResult {
  org: string;
  login: string;
  projects: DiagnosedProject[];
  status_count: number;
  /** `repo#number -> Status 原文` 采样（后端为 `[key, value][]` 数组）。 */
  sample_statuses: [string, string][] | null;
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

/** #235：一次 API 调用的请求/返回参数明细（同步 / 认领 / 状态写回）。 */
export interface ApiLog {
  id: number;
  /** `sync` | `claim` | `status` */
  kind: string;
  accountId: number;
  /** 关联的 sync_logs.id；独立写回操作为 0。 */
  syncLogId: number;
  method: string;
  target: string;
  status: number;
  ok: boolean;
  elapsedMs: number;
  request: string;
  response: string;
  createdAt: number;
}

/** v0.3.24+：记事本记录。 */
export interface Note {
  id: number;
  content: string;
  label: 'low' | 'medium' | 'high' | 'urgent';
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
 * #263：单个 agent 的设备探测结果。
 *
 * `kind` 为最强信号：`cli`（PATH 上有可执行文件）/ `app`（macOS 应用包）/
 * `config-only`（只剩配置目录，疑似已卸载或历史残留）/ `none`（未检测到）。
 */
export interface AgentHostInfo {
  agent: string;
  present: boolean;
  kind: AgentHostKind;
  binary: string | null;
  configDir: string | null;
  app: string | null;
}

export type AgentHostKind = 'cli' | 'app' | 'config-only' | 'none';

/** #263：一次设备扫描的结果（含与上次快照的差异）。 */
export interface AgentScanResult {
  scannedAt: number;
  /** 上次扫描时间；首次扫描为 null。 */
  previousScannedAt: number | null;
  hasPrevious: boolean;
  agents: AgentHostInfo[];
  /** 上次无信号、本次有 → 新发现安装。 */
  newlyInstalled: string[];
  /** 上次有可执行文件/应用包、本次消失 → 疑似已卸载。 */
  newlyRemoved: string[];
}

/**
 * 四态列定义。label / hint 走 i18n：status.{key} / hint.{key}
 * （Issue #7 起不再硬编码中文文案）。
 */
export const COLUMNS: { key: StatusKey }[] = [
  { key: 'todo' },
  { key: 'doing' },
  { key: 'processed' },
  { key: 'done' },
];
