import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { useI18n } from "../i18n";
import type { SyncLog } from "../types";

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

/** 状态徽章。 */
function StatusBadge({ status }: { status: string }) {
  if (status === "success") {
    return <span className="badge success">✓ 成功</span>;
  }
  if (status === "failed") {
    return <span className="badge error">✗ 失败</span>;
  }
  return <span className="badge muted">⏳ 进行中</span>;
}

/** v0.3.23+ 同步日志弹窗：展示最近的同步历史与错误。 */
export default function SyncLogsPanel({ onClose }: Props) {
  const { t } = useI18n();
  const [logs, setLogs] = useState<SyncLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [pruning, setPruning] = useState(false);
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

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal sync-logs-modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">同步日志</h3>

        <div className="sync-logs-body">
          {error ? (
            <div className="banner error">{error}</div>
          ) : loading ? (
            <div className="muted small" style={{ padding: "12px 0" }}>
              加载中...
            </div>
          ) : logs.length === 0 ? (
            <div className="muted small" style={{ padding: "12px 0" }}>
              暂无同步日志
            </div>
          ) : (
            <div className="sync-logs-table-wrap">
              <table className="sync-logs-table">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>触发</th>
                    <th>耗时</th>
                    <th>状态</th>
                    <th>新增</th>
                    <th>更新</th>
                    <th>移除</th>
                    <th>错误</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((log) => (
                    <tr key={log.id}>
                      <td className="nowrap">{formatTime(log.createdAt)}</td>
                      <td>{log.triggerType === "manual" ? "手动" : "自动"}</td>
                      <td>{duration(log.startedAt, log.finishedAt)}</td>
                      <td><StatusBadge status={log.status} /></td>
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
            {pruning ? "清理中..." : "清理过期日志"}
          </button>
        </div>
      </div>
    </div>
  );
}
