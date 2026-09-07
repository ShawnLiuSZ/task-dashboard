import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { useI18n, type LangMode } from "../i18n";
import type { AccountColumn, Settings } from "../types";

interface Props {
  settings: Settings;
  onSaved: (s: Settings) => void;
  onClose: () => void;
}

const PRESETS = [15, 30, 60, 120, 240];

function emptyCol(): { colKey: string; colName: string; matchRules: string; orderIndex: number } {
  return { colKey: "", colName: "", matchRules: "", orderIndex: 0 };
}

export default function SettingsPanel({
  settings,
  onSaved,
  onClose,
}: Props) {
  const { t, mode, setMode } = useI18n();
  const [minutes, setMinutes] = useState(settings.scheduleMinutes);
  const [ghPath, setGhPath] = useState(settings.ghPath);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [diagBusy, setDiagBusy] = useState(false);
  const [diagMsg, setDiagMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [diagAccountId, setDiagAccountId] = useState<number | null>(
    settings.accounts.find((a) => a.isDefault)?.id ?? settings.accounts[0]?.id ?? null,
  );
  const [projects, setProjects] = useState<any[]>([]);

  // v0.3.28+：自定义列映射状态
  const [colAccountId, setColAccountId] = useState<number | null>(
    settings.accounts.find((a) => a.isDefault)?.id ?? settings.accounts[0]?.id ?? null,
  );
  const [columns, setColumns] = useState<AccountColumn[]>([]);
  const [colSaving, setColSaving] = useState(false);
  const [colMsg, setColMsg] = useState<string | null>(null);
  const [editingCol, setEditingCol] = useState<{
    index: number; // -1 = 新增
    colKey: string;
    colName: string;
    matchRules: string;
    orderIndex: number;
  } | null>(null);

  const loadColumns = useCallback(async (accountId: number) => {
    try {
      const cols = await api.listAccountColumns(accountId);
      setColumns(cols.sort((a, b) => a.orderIndex - b.orderIndex));
    } catch {
      setColumns([]);
    }
  }, []);

  // 账号切换时重新加载列配置
  useEffect(() => {
    if (colAccountId != null) {
      void loadColumns(colAccountId);
    }
  }, [colAccountId, loadColumns]);

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      onSaved(await api.saveSettings(minutes, ghPath));
    } catch (e) {
      setErr(String(e));
    } finally {
      setSaving(false);
    }
  };

  const saveColumns = async () => {
    if (colAccountId == null) return;
    setColSaving(true);
    setColMsg(null);
    try {
      await api.saveAccountColumns(colAccountId, columns);
      setColMsg(t("settings.customColumns.saved"));
      await loadColumns(colAccountId);
    } catch (e) {
      setColMsg(String(e));
    } finally {
      setColSaving(false);
    }
  };

  const startAddCol = () => {
    setEditingCol({ index: -1, ...emptyCol(), orderIndex: columns.length });
  };

  const startEditCol = (col: AccountColumn, idx: number) => {
    let rules = col.matchRules;
    // 尝试解析为 JSON 数组并转为逗号分隔
    try {
      const arr = JSON.parse(col.matchRules);
      if (Array.isArray(arr)) {
        rules = arr.join(", ");
      }
    } catch { /* 保持原样 */ }
    setEditingCol({
      index: idx,
      colKey: col.colKey,
      colName: col.colName,
      matchRules: rules,
      orderIndex: col.orderIndex,
    });
  };

  const confirmEditCol = () => {
    if (!editingCol) return;
    const { index, colKey, colName, matchRules, orderIndex } = editingCol;
    // 校验
    if (!colKey.trim() || !colName.trim()) return;

    // 将逗号分隔的 matchRules 转为 JSON 数组
    const rulesArr = matchRules
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const rulesJson = JSON.stringify(rulesArr);

    const newCol: AccountColumn = {
      id: index >= 0 ? columns[index].id : 0,
      accountId: colAccountId ?? 0,
      colKey: colKey.trim(),
      colName: colName.trim(),
      matchRules: rulesJson,
      orderIndex,
    };

    if (index >= 0) {
      // 编辑已有列
      const updated = [...columns];
      updated[index] = newCol;
      setColumns(updated);
    } else {
      // 新增列
      setColumns([...columns, newCol]);
    }
    setEditingCol(null);
  };

  const deleteCol = (idx: number) => {
    setColumns(columns.filter((_, i) => i !== idx));
  };

  const cancelEditCol = () => {
    setEditingCol(null);
  };

  const diagnoseProject = async () => {
    if (diagAccountId == null) {
      setDiagMsg({ ok: false, text: t("settings.projectDiagDefaultAcc") });
      return;
    }
    setDiagBusy(true);
    setDiagMsg(null);
    try {
      const res = await api.diagnoseProjectStatus(diagAccountId);
      const projs = (res.projects ?? []) as any[];
      const statusKeys = Object.keys(res.sample_statuses ?? {});
      setDiagMsg({
        ok: true,
        text:
          t("settings.diagOrgUser", { org: res.org, login: res.login }) +
          "\n" +
          t("settings.diagProjects", {
            count: projs.length,
            names:
              projs.map((p: any) => p.name).join("、") ||
              t("settings.diagNone"),
          }) +
          "\n" +
          t("settings.diagStatuses", { count: res.status_count }) +
          (statusKeys.length
            ? t("settings.diagExample", { keys: statusKeys.slice(0, 8).join("、") })
            : ""),
      });
    } catch (e) {
      setDiagMsg({ ok: false, text: String(e) });
    } finally {
      setDiagBusy(false);
    }
  };

  const loadProjects = async (accountId: number) => {
    try {
      setProjects(await api.listProjects(accountId));
    } catch {
      setProjects([]);
    }
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">{t("settings.title")}</h3>

        <div className="field">
          <label>{t("settings.language")}</label>
          <select
            className="select"
            value={mode}
            onChange={(e) => setMode(e.target.value as LangMode)}
          >
            <option value="auto">{t("settings.langAuto")}</option>
            <option value="zh-CN">{t("settings.langZh")}</option>
            <option value="en-US">{t("settings.langEn")}</option>
          </select>
        </div>

        <div className="field">
          <label>{t("settings.syncInterval")}</label>
          <div className="row">
            <input
              className="input"
              type="number"
              min={5}
              value={minutes}
              onChange={(e) => setMinutes(Math.max(5, Number(e.target.value) || 5))}
            />
            <span className="muted">{t("unit.minutes")}</span>
          </div>
          <div className="presets">
            {PRESETS.map((p) => (
              <button
                key={p}
                className={`chip${minutes === p ? " on" : ""}`}
                onClick={() => setMinutes(p)}
              >
                {t("settings.presetMinutes", { n: p })}
              </button>
            ))}
          </div>
          <div className="muted small">{t("settings.intervalHint")}</div>
        </div>

        <div className="field">
          <label>{t("settings.projectDiag")}</label>
          <div className="row" style={{ marginTop: 4 }}>
            <select
              className="select"
              value={diagAccountId ?? ""}
              onChange={(e) => {
                const id = Number(e.target.value);
                setDiagAccountId(id);
                void loadProjects(id);
              }}
            >
              {settings.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}{a.isDefault ? " ★" : ""}
                </option>
              ))}
            </select>
            <button
              className="btn"
              onClick={() => { void diagnoseProject(); if (diagAccountId) void loadProjects(diagAccountId); }}
              disabled={diagBusy || settings.accounts.length === 0}
            >
              {diagBusy ? t("settings.loading") : t("settings.projectDiag")}
            </button>
          </div>
          <div className="muted small">{t("settings.projectDiagHint")}</div>
          {projects.length > 0 && (
            <div className="project-list" style={{ marginTop: 6 }}>
              {projects.map((p: any) => (
                <div key={p.id} className="project-row">
                  <span className="project-name">{p.name}</span>
                  <span className="muted small">{p.numberOfItems} items · {p.ownerType}</span>
                </div>
              ))}
            </div>
          )}
          {diagMsg && (
            <div className={`banner ${diagMsg.ok ? "ok" : "error"} inline diag-banner`}>
              {diagMsg.text}
            </div>
          )}
        </div>

        <div className="field">
          <label>{t("settings.customColumnsTitle")}</label>
          <div className="muted small" style={{ marginBottom: 6 }}>{t("settings.customColumnsDesc")}</div>

          <div className="row" style={{ marginTop: 4, marginBottom: 8 }}>
            <select
              className="select"
              value={colAccountId ?? ""}
              onChange={(e) => {
                const id = Number(e.target.value);
                setColAccountId(id);
              }}
            >
              {settings.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}{a.isDefault ? " ★" : ""}
                </option>
              ))}
            </select>
            <button className="btn" onClick={startAddCol} disabled={colAccountId == null}>
              + {t("settings.customColumns.add")}
            </button>
            <button className="btn primary" onClick={saveColumns} disabled={colSaving || colAccountId == null}>
              {colSaving ? t("settings.loading") : t("btn.save")}
            </button>
          </div>

          {colMsg && (
            <div className={`banner inline ${colMsg === t("settings.customColumns.saved") ? "ok" : "error"}`} style={{ marginBottom: 6 }}>
              {colMsg}
            </div>
          )}

          {/* 列编辑表单 */}
          {editingCol && (
            <div className="col-editor" style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 10, marginBottom: 8 }}>
              <div className="row" style={{ gap: 6, marginBottom: 6 }}>
                <div style={{ flex: 1 }}>
                  <label className="small">{t("settings.customColumns.colKey")}</label>
                  <input
                    className="input"
                    placeholder="col_0"
                    value={editingCol.colKey}
                    onChange={(e) => setEditingCol({ ...editingCol, colKey: e.target.value })}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <label className="small">{t("settings.customColumns.colName")}</label>
                  <input
                    className="input"
                    placeholder="待开发"
                    value={editingCol.colName}
                    onChange={(e) => setEditingCol({ ...editingCol, colName: e.target.value })}
                  />
                </div>
              </div>
              <div style={{ marginBottom: 6 }}>
                <label className="small">{t("settings.customColumns.matchRules")}</label>
                <input
                  className="input wide"
                  placeholder={t("settings.customColumns.matchRulesHint")}
                  value={editingCol.matchRules}
                  onChange={(e) => setEditingCol({ ...editingCol, matchRules: e.target.value })}
                />
              </div>
              <div className="row" style={{ gap: 6 }}>
                <button className="btn primary" onClick={confirmEditCol} disabled={!editingCol.colKey.trim() || !editingCol.colName.trim()}>
                  {t("btn.done")}
                </button>
                <button className="btn" onClick={cancelEditCol}>
                  {t("btn.cancel")}
                </button>
              </div>
            </div>
          )}

          {/* 列列表 */}
          {columns.length === 0 && !editingCol && (
            <div className="muted small">{t("settings.customColumns.empty")}</div>
          )}
          {columns.map((col, idx) => (
            <div key={idx} className="col-row" style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", borderBottom: "1px solid var(--border)" }}>
              <span className="chip" style={{ minWidth: 24, textAlign: "center" }}>{idx}</span>
              <span style={{ flex: 1, fontWeight: 500 }}>{col.colName}</span>
              <span className="muted small" style={{ flex: 1 }}>{col.colKey}</span>
              <span className="muted small" style={{ flex: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {(() => {
                  try {
                    const arr = JSON.parse(col.matchRules);
                    return Array.isArray(arr) ? arr.join(", ") : col.matchRules;
                  } catch { return col.matchRules; }
                })()}
              </span>
              <button className="btn ghost small" onClick={() => startEditCol(col, idx)} title={t("settings.customColumns.edit")}>
                {t("settings.customColumns.edit")}
              </button>
              <button className="btn ghost small" onClick={() => deleteCol(idx)} title={t("settings.customColumns.delete")}>
                {t("settings.customColumns.delete")}
              </button>
            </div>
          ))}
        </div>

        <div className="field">
          <label>{t("settings.ghPathLabel")}</label>
          <input
            className="input wide"
            placeholder={t("settings.ghPathPlaceholder")}
            value={ghPath}
            onChange={(e) => setGhPath(e.target.value)}
          />
          <div className="muted small">{t("settings.ghPathHint")}</div>
        </div>

        <div className="field readonly">
          <label>{t("settings.orgLabel")}</label>
          <div className="muted">
            {settings.org}
            {t("settings.orgHint")}
          </div>
        </div>

        <div className="field readonly">
          <label>{t("settings.dbLabel")}</label>
          <div className="muted small path">{settings.dbPath}</div>
        </div>

        {err && <div className="banner error">{err}</div>}

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            {t("btn.cancel")}
          </button>
          <button className="btn primary" onClick={save} disabled={saving}>
            {saving ? t("btn.saving") : t("btn.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
