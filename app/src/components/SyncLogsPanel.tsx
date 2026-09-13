import { Fragment, useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { useI18n } from "../i18n";
import ConfirmDialog from "./ConfirmDialog";
import type { ApiLog, SyncLog } from "../types";

/** v0.3.49 (#148)：同步触发类型走 i18n（此前硬编码中文）。 */
function triggerLabel(t: (key: string) => string, triggerType: string): string {
  if (triggerType === "auto") return t("syncLogs.trigger.auto");
  if (triggerType === "manual") return t("syncLogs.trigger.manual");
  if (triggerType === "startup") return t("syncLogs.trigger.startup");
  return triggerType;
}

interface Props {
  onClose: () => void;
}

/** 格式化 Unix 时间戳为本地时间字符串。 */
function formatTime(ts: number): string {
  if (!ts) return "-";
  const d = new Date(ts * 1000);
  return d.toLocaleString();
}

/** 计算持续时间（秒）。 */
function duration(start: number, end: number): string {
  if (!start || !end) return "-";
  const secs = Math.max(0, end - start);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return `${mins}m ${rem}s`;
}

/** v0.3.51 (#161)：错误单元格展示文本；无错误时返回 null 渲染 "-"。 */
export function syncLogErrorText(
  log: Pick<SyncLog, "errorMessage" | "failedSources">,
): string | null {
  return log.errorMessage || log.failedSources || null;
}

/** v0.3.51 (#161)：错误单元格展开/收起切换（单展开：再次点击同一行则收起）。 */
export function toggleExpanded(expandedId: number | null, id: number): number | null {
  return expandedId === id ? null : id;
}

/** #224：日志行账号展示（账号已删回退 `#id`）。 */
export function accountLabelForLog(
  accounts: { id: number; login: string }[],
  accountId: number,
): string {
  const a = accounts.find((x) => x.id === accountId);
  return a ? `@${a.login}` : `#${accountId}`;
}

/** #235：API 明细类型 → i18n 文案（未知类型原样返回）。 */
export function apiLogKindLabel(
  t: (key: string) => string,
  kind: string,
): string {
  if (kind === "sync") return t("syncLogs.api.kind.sync");
  if (kind === "claim") return t("syncLogs.api.kind.claim");
  if (kind === "status") return t("syncLogs.api.kind.status");
  return kind;
}

/** #235：按类型筛选（`all` 不过滤）。纯函数，可单测。 */
export function filterApiLogs(logs: ApiLog[], kind: string): ApiLog[] {
  if (!kind || kind === "all") return logs;
  return logs.filter((l) => l.kind === kind);
}

/** #235：参数单元格展示文本；空白返回 null，由调用方渲染 "-"。 */
export function apiLogParamText(value: string): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

/** #235：明细是否可展开（请求或返回至少有一个非空）。 */
export function apiLogHasDetail(log: Pick<ApiLog, "request" | "response">): boolean {
  return apiLogParamText(log.request) !== null || apiLogParamText(log.response) !== null;
}

/** 状态徽章（文案走 i18n）。 */
function StatusBadge({ status, t }: { status: string; t: (key: string) => string }) {
  if (status === "success") {
    return <span className="badge success">✓ {t("syncLogs.status.success")}</span>;
  }
  if (status === "failed") {
    return <span className="badge error">✗ {t("syncLogs.status.failed")}</span>;
  }
  return <span className="badge muted">⏳ {t("syncLogs.status.running")}</span>;
}

/** v0.3.23+ 同步日志弹窗：展示最近的同步历史与错误。 */
export default function SyncLogsPanel({ onClose }: Props) {
  const { t } = useI18n();
  const [tab, setTab] = useState<"sync" | "api">("sync");
  const [logs, setLogs] = useState<SyncLog[]>([]);
  const [apiLogs, setApiLogs] = useState<ApiLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [pruning, setPruning] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // #224：账号 id → login（日志行展示所属账号）。
  const [accounts, setAccounts] = useState<{ id: number; login: string }[]>([]);
  // #235：API 明细类型筛选 + 展开行。
  const [kindFilter, setKindFilter] = useState("all");
  const [expandedApiId, setExpandedApiId] = useState<number | null>(null);

  const loadLogs = useCallback(async () => {
    setLoading(true);
    try {
      const [data, apiData, settings] = await Promise.all([
        api.listSyncLogs(100),
        api.listApiLogs(300),
        api.getSettings(),
      ]);
      setLogs(data);
      setApiLogs(apiData);
      setAccounts(
        (settings.accounts ?? []).map((a) => ({ id: a.id, login: a.login })),
      );
      setError(null);
    } catch (e) {
      // 失败必须可见：原先只 console.error，面板仍显示「暂无同步日志」，用户会误判。
      console.error("加载同步日志失败:", e);
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadLogs();
  }, [loadLogs]);

  const handlePrune = useCallback(async () => {
    setPruning(true);
    try {
      // #235：同步记录与 API 明细一起清理，避免只清一半。
      await Promise.all([api.pruneSyncLogs(), api.pruneApiLogs()]);
      await loadLogs();
    } catch (e) {
      console.error("清理同步日志失败:", e);
      setError(String(e));
    } finally {
      setPruning(false);
    }
  }, [loadLogs]);

  const handleClear = useCallback(async () => {
    setClearing(true);
    try {
      await Promise.all([api.clearSyncLogs(), api.clearApiLogs()]);
      await loadLogs();
    } catch (e) {
      console.error("清空同步日志失败:", e);
      setError(String(e));
    } finally {
      setClearing(false);
    }
  }, [loadLogs]);

  // v0.3.49 (#150)：Esc 关闭 + dialog 语义。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const visibleApiLogs = filterApiLogs(apiLogs, kindFilter);

  return (
    <div className="modal-mask" onClick={onClose}>
      <div
        className="modal sync-logs-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t("syncLogs.title")}
      >
        <h3 className="modal-title">{t("syncLogs.title")}</h3>

        {/* #235：两个页签 —— 同步记录（聚合）/ API 明细（请求与返回参数）。 */}
        <div className="sync-logs-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "sync"}
            className={`chip tab${tab === "sync" ? " on" : ""}`}
            onClick={() => setTab("sync")}
          >
            {t("syncLogs.tabs.sync")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "api"}
            className={`tab${tab === "api" ? " active" : ""}`}
            onClick={() => setTab("api")}
          >
            {t("syncLogs.tabs.api")}
          </button>
        </div>

        <div className="sync-logs-body">
          {error ? (
            <div className="banner error">{error}</div>
          ) : loading ? (
            <div className="muted small" style={{ padding: "12px 0" }}>
              {t("syncLogs.loading")}
            </div>
          ) : tab === "sync" ? (
            logs.length === 0 ? (
              <div className="muted small" style={{ padding: "12px 0" }}>
                {t("syncLogs.empty")}
              </div>
            ) : (
              <div className="sync-logs-table-wrap">
                <table className="sync-logs-table">
                  <thead>
                    <tr>
                      <th>{t("syncLogs.headers.time")}</th>
                      <th>{t("syncLogs.headers.account")}</th>
                      <th>{t("syncLogs.headers.trigger")}</th>
                      <th>{t("syncLogs.headers.duration")}</th>
                      <th>{t("syncLogs.headers.status")}</th>
                      <th>{t("syncLogs.headers.added")}</th>
                      <th>{t("syncLogs.headers.updated")}</th>
                      <th>{t("syncLogs.headers.removed")}</th>
                      <th>{t("syncLogs.headers.error")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logs.map((log) => (
                      <tr key={log.id}>
                        <td className="nowrap">{formatTime(log.createdAt)}</td>
                        <td className="nowrap">{accountLabelForLog(accounts, log.accountId)}</td>
                        <td>{triggerLabel(t, log.triggerType)}</td>
                        <td>{duration(log.startedAt, log.finishedAt)}</td>
                        <td><StatusBadge status={log.status} t={t} /></td>
                        <td>{log.added}</td>
                        <td>{log.updated}</td>
                        <td>{log.removed}</td>
                        <td className="error-cell">
                          {syncLogErrorText(log) ? (
                            <button
                              type="button"
                              className={`error-toggle${expandedId === log.id ? " expanded" : ""}`}
                              title={syncLogErrorText(log) ?? undefined}
                              aria-label={t("syncLogs.errorExpandHint")}
                              onClick={() => setExpandedId(toggleExpanded(expandedId, log.id))}
                            >
                              {syncLogErrorText(log)}
                            </button>
                          ) : (
                            "-"
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          ) : apiLogs.length === 0 ? (
            <div className="muted small" style={{ padding: "12px 0" }}>
              {t("syncLogs.api.empty")}
            </div>
          ) : (
            <>
              <div className="sync-logs-filter">
                {(["all", "sync", "claim", "status"] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    className={`chip${kindFilter === k ? " active" : ""}`}
                    aria-pressed={kindFilter === k}
                    onClick={() => setKindFilter(k)}
                  >
                    {k === "all"
                      ? t("syncLogs.api.filter.all")
                      : apiLogKindLabel(t, k)}
                    <span className="chip-count">
                      {filterApiLogs(apiLogs, k).length}
                    </span>
                  </button>
                ))}
              </div>
              {visibleApiLogs.length === 0 ? (
                <div className="muted small" style={{ padding: "12px 0" }}>
                  {t("syncLogs.api.empty")}
                </div>
              ) : (
                <div className="sync-logs-table-wrap">
                  <table className="sync-logs-table api-logs-table">
                    <thead>
                      <tr>
                        <th>{t("syncLogs.headers.time")}</th>
                        <th>{t("syncLogs.api.headers.kind")}</th>
                        <th>{t("syncLogs.api.headers.method")}</th>
                        <th>{t("syncLogs.api.headers.target")}</th>
                        <th>{t("syncLogs.api.headers.status")}</th>
                        <th>{t("syncLogs.api.headers.elapsed")}</th>
                        <th>{t("syncLogs.api.headers.detail")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleApiLogs.map((log) => (
                        <Fragment key={log.id}>
                          <tr>
                            <td className="nowrap">{formatTime(log.createdAt)}</td>
                            <td className="nowrap">{apiLogKindLabel(t, log.kind)}</td>
                            <td className="nowrap">{log.method}</td>
                            <td className="mono" title={log.target}>{log.target}</td>
                            <td className="nowrap">
                              <span className={`badge ${log.ok ? "success" : "error"}`}>
                                {log.ok ? "✓" : "✗"} {log.status}
                              </span>
                            </td>
                            <td className="nowrap">{log.elapsedMs}ms</td>
                            <td className="error-cell">
                              {apiLogHasDetail(log) ? (
                                <button
                                  type="button"
                                  className={`error-toggle${expandedApiId === log.id ? " expanded" : ""}`}
                                  aria-label={t("syncLogs.api.detailHint")}
                                  title={t("syncLogs.api.detailHint")}
                                  onClick={() =>
                                    setExpandedApiId(toggleExpanded(expandedApiId, log.id))
                                  }
                                >
                                  {t("syncLogs.api.view")}
                                </button>
                              ) : (
                                "-"
                              )}
                            </td>
                          </tr>
                          {expandedApiId === log.id && (
                            <tr key={`${log.id}-detail`} className="api-log-detail-row">
                              <td colSpan={7}>
                                <div className="api-log-param">
                                  <span className="api-log-param-label">
                                    {t("syncLogs.api.requestLabel")}
                                  </span>
                                  <pre className="api-log-param-body">
                                    {apiLogParamText(log.request) ?? t("syncLogs.api.none")}
                                  </pre>
                                </div>
                                <div className="api-log-param">
                                  <span className="api-log-param-label">
                                    {t("syncLogs.api.responseLabel")}
                                  </span>
                                  <pre className="api-log-param-body">
                                    {apiLogParamText(log.response) ?? t("syncLogs.api.none")}
                                  </pre>
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            {t("btn.close")}
          </button>
          <button
            className="btn"
            onClick={handlePrune}
            disabled={pruning}
          >
            {pruning ? t("syncLogs.pruning") : t("syncLogs.pruneExpired")}
          </button>
          <button
            className="btn ghost"
            onClick={() => setConfirming(true)}
            disabled={clearing}
          >
            {clearing ? t("syncLogs.pruning") : t("syncLogs.clearAll")}
          </button>
        </div>

        {confirming && (
          <ConfirmDialog
            message={t("syncLogs.clearAllConfirm")}
            onCancel={() => setConfirming(false)}
            onConfirm={() => {
              setConfirming(false);
              void handleClear();
            }}
          />
        )}
      </div>
    </div>
  );
}
