import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { useI18n } from "../i18n";
import type { SyncLog } from "../types";

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
  const [logs, setLogs] = useState<SyncLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [pruning, setPruning] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadLogs = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.listSyncLogs(100);
      setLogs(data);
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
      await api.pruneSyncLogs();
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
      await api.clearSyncLogs();
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

        <div className="sync-logs-body">
          {error ? (
            <div className="banner error">{error}</div>
          ) : loading ? (
            <div className="muted small" style={{ padding: "12px 0" }}>
              {t("syncLogs.loading")}
            </div>
          ) : logs.length === 0 ? (
            <div className="muted small" style={{ padding: "12px 0" }}>
              {t("syncLogs.empty")}
            </div>
          ) : (
            <div className="sync-logs-table-wrap">
              <table className="sync-logs-table">
                <thead>
                  <tr>
                    <th>{t("syncLogs.headers.time")}</th>
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
                      <td>{triggerLabel(t, log.triggerType)}</td>
                      <td>{duration(log.startedAt, log.finishedAt)}</td>
                      <td><StatusBadge status={log.status} t={t} /></td>
                      <td>{log.added}</td>
                      <td>{log.updated}</td>
                      <td>{log.removed}</td>
                      <td className="error-cell">
                        {log.errorMessage || log.failedSources || "-"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
            onClick={() => {
              if (window.confirm(t("syncLogs.clearAllConfirm"))) {
                void handleClear();
              }
            }}
            disabled={clearing}
          >
            {clearing ? t("syncLogs.pruning") : t("syncLogs.clearAll")}
          </button>
        </div>
      </div>
    </div>
  );
}
