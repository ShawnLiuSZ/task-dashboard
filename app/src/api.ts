import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  Account,
  AccountColumn,
  BoardMode,
  CheckUpdate,
  DeviceLoginPoll,
  DeviceLoginStart,
  LabelMapping,
  LabelMappingInput,
  Note,
  PatStatus,
  Project,
  ProjectStatus,
  Settings,
  SyncLog,
  SyncResult,
  Task,
  ViewMode,
} from "./types";

export const SYNCED_EVENT = "taskboard://synced";

export const api = {
  listTasks: (ownership?: string, accountId?: number | null) =>
    invoke<Task[]>("list_tasks", {
      ownership: ownership ?? null,
      accountId: accountId ?? null,
    }),
  syncNow: () => invoke<SyncResult>("sync_now"),
  updateStatus: (key: string, status: string) =>
    invoke<void>("update_task_status", { key, status }),
  recordSession: (key: string, sessionId: string, agent?: string) =>
    invoke<void>("record_session", { key, sessionId, agent: agent ?? null }),
  clearSession: (key: string) => invoke<void>("clear_session", { key }),
  recordHandoff: (key: string, text: string) =>
    invoke<void>("record_handoff", { key, text }),
  getSettings: () => invoke<Settings>("get_settings"),
  saveSettings: (scheduleMinutes: number, ghPath: string) =>
    invoke<Settings>("save_settings", { scheduleMinutes, ghPath }),
  openInBrowser: (url: string) => invoke<void>("open_in_browser", { url }),
  // v0.3.15+：GitHub PAT 相关命令（保留兼容，新版用账号管理）。
  savePat: (pat: string) => invoke<PatStatus>("save_pat", { pat }),
  testPat: () => invoke<PatStatus>("test_pat"),
  clearPat: () => invoke<PatStatus>("clear_pat"),
  // v0.3.16+：多账号管理。
  listAccounts: () => invoke<Account[]>("list_accounts"),
  addAccount: (label: string, login: string, org: string, pat: string) =>
    invoke<Account>("add_account", { label, login, org, pat }),
  updateAccount: (
    id: number,
    label: string | null,
    login: string | null,
    org: string | null,
    pat: string | null,
  ) => invoke<Account>("update_account", { id, label, login, org, pat }),
  deleteAccount: (id: number) => invoke<void>("delete_account", { id }),
  testAccountPat: (id: number) => invoke<PatStatus>("test_account_pat", { id }),
  setDefaultAccount: (id: number) =>
    invoke<void>("set_default_account", { id }),
  setActiveAccount: (id: number) =>
    invoke<void>("set_active_account", { id }),
  setViewMode: (mode: ViewMode) => invoke<void>("set_view_mode", { mode }),
  // v0.3.17+：GitHub OAuth Device Flow 登录（token 不回流前端，成功即建账号）。
  saveOauthClientId: (clientId: string) =>
    invoke<void>("save_oauth_client_id", { clientId }),
  deviceLoginStart: (clientId: string) =>
    invoke<DeviceLoginStart>("device_login_start", { clientId }),
  deviceLoginPoll: (clientId: string, deviceCode: string, org: string, label: string) =>
    invoke<DeviceLoginPoll>("device_login_poll", { clientId, deviceCode, org, label }),
  // v0.3.19+：关于页面 —— 当前版本 + 检查更新。
  getAppVersion: () => invoke<string>("get_app_version"),
  checkLatestRelease: () =>
    invoke<CheckUpdate>("check_latest_release"),
  // v0.3.20+：Label→Status 映射管理。
  listLabelMappings: () => invoke<LabelMapping[]>("list_label_mappings"),
  upsertLabelMapping: (input: LabelMappingInput) =>
    invoke<LabelMapping>("upsert_label_mapping", {
      org: input.org,
      repo: input.repo,
      label: input.label,
      status: input.status,
      orderIndex: input.orderIndex,
    }),
  deleteLabelMapping: (id: number) => invoke<void>("delete_label_mapping", { id }),
  // v0.3.21+：看板列模式切换 + Label 列视图配置。
  setBoardMode: (mode: BoardMode) => invoke<void>("set_board_mode", { mode }),
  getLabelColumnsForAccount: (accountId: number) =>
    invoke<LabelMapping[]>("get_label_columns_for_account", { accountId }),
  // v0.3.22+：Project Status 诊断。
  diagnoseProjectStatus: (accountId: number) =>
    invoke<any>("diagnose_project_status", { accountId }),
  listProjects: (accountId: number) =>
    invoke<Project[]>("list_projects", { accountId }),
  listProjectStatuses: (accountId: number) =>
    invoke<ProjectStatus[]>("list_project_statuses", { accountId }),
  // v0.3.23+：同步日志管理。
  listSyncLogs: (limit?: number) =>
    invoke<SyncLog[]>("list_sync_logs", { limit: limit ?? 50 }),
  pruneSyncLogs: () => invoke<number>("prune_sync_logs"),
  // v0.3.24+：记事本管理。
  listNotes: () => invoke<Note[]>("list_notes"),
  addNote: (content: string, label?: string) =>
    invoke<Note>("add_note", { content, label: label ?? null }),
  updateNote: (id: number, content: string) =>
    invoke<Note>("update_note", { id, content }),
  updateNoteLabel: (id: number, label: string) =>
    invoke<Note>("update_note_label", { id, label }),
  deleteNote: (id: number) => invoke<void>("delete_note", { id }),
  // v0.3.27+：记事本导出 / 导入。
  exportNotes: () =>
    invoke<{ path: string; count: number }>("export_notes"),
  importNotes: (json: string) =>
    invoke<{ imported: number; skipped: number }>("import_notes", { json }),
  // v0.3.28+：自定义列映射（按账号配置看板列）。
  listAccountColumns: (accountId: number) =>
    invoke<AccountColumn[]>("list_account_columns", { accountId }),
  saveAccountColumns: (accountId: number, columns: AccountColumn[]) =>
    invoke<void>("save_account_columns", { accountId, columns }),
};
export function onSynced(cb: (r: SyncResult) => void) {
  return listen<SyncResult>(SYNCED_EVENT, (e) => cb(e.payload));
}

/**
 * v0.3.28+：全局错误上报通道。
 *
 * 用途：无 UI 上下文的异步失败（典型如 openInBrowser）若只 `console.error`，
 * 用户侧表现为「点了没反应」。统一派发该事件，由 App 监听并显示在错误 banner。
 */
export const TASKBOARD_ERROR_EVENT = "taskboard://error";

export function reportError(e: unknown): void {
  const msg = String(e);
  console.error("[taskboard]", msg);
  window.dispatchEvent(
    new CustomEvent<string>(TASKBOARD_ERROR_EVENT, { detail: msg }),
  );
}

/** 打开外部链接；失败时经 reportError 给出可见提示，不再静默吞掉。 */
export function openExternal(url: string): void {
  api.openInBrowser(url).catch(reportError);
}
