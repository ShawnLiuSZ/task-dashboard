import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { useI18n, type LangMode } from "../i18n";
import type { Account, AccountColumn, BoardMode, Settings } from "../types";

interface Props {
  settings: Settings;
  onSaved: (s: Settings) => void;
  onClose: () => void;
}

const PRESETS = [15, 30, 60, 120, 240];

// 自动生成稳定的自定义列标识
function genColKey(): string {
  return `col_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

// 解析列的 matchRules
function parseMatchRules(matchRules: string): string[] {
  try {
    const arr = JSON.parse(matchRules);
    if (Array.isArray(arr)) {
      return [...new Set(arr.filter((s): s is string => typeof s === "string").map((s) => s.trim()).filter((s) => s.length > 0))];
    }
  } catch {
    // 兼容旧数据：逗号分隔
  }
  return [...new Set(matchRules.split(/[,，]/).map((s) => s.trim()).filter((s) => s.length > 0))];
}

type SettingsTab = "base" | "columns" | "diagnose";

// 每个账号的编辑状态
interface AccountEditState {
  columns: AccountColumn[];
  editingCol: {
    index: number;
    colKey: string;
    colName: string;
    matchRules: string;
    orderIndex: number;
  } | null;
  ruleChips: string[];
  ruleInput: string;
  availableStatuses: string[];
  saving: boolean;
  msg: string | null;
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

  // v0.3.48+：每个账号独立的编辑状态
  const [accountStates, setAccountStates] = useState<Record<number, AccountEditState>>({});

  // v0.3.41+：设置面板 tab 切换
  const [tab, setTab] = useState<SettingsTab>("base");

  // 初始化：加载所有账号的列配置
  useEffect(() => {
    const init = async () => {
      const states: Record<number, AccountEditState> = {};
      for (const acct of settings.accounts) {
        try {
          const cols = await api.listAccountColumns(acct.id);
          const statuses = await api.listProjectStatuses(acct.id);
          states[acct.id] = {
            columns: cols.sort((a, b) => a.orderIndex - b.orderIndex),
            editingCol: null,
            ruleChips: [],
            ruleInput: "",
            availableStatuses: [...new Set(statuses.map((p) => p.name).filter(Boolean))],
            saving: false,
            msg: null,
          };
        } catch {
          states[acct.id] = {
            columns: [],
            editingCol: null,
            ruleChips: [],
            ruleInput: "",
            availableStatuses: [],
            saving: false,
            msg: null,
          };
        }
      }
      setAccountStates(states);
    };
    void init();
  }, [settings.accounts]);

  const updateAccountState = useCallback((accountId: number, patch: Partial<AccountEditState>) => {
    setAccountStates((prev) => ({
      ...prev,
      [accountId]: { ...prev[accountId], ...patch },
    }));
  }, []);

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

  const saveColumns = async (accountId: number) => {
    const st = accountStates[accountId];
    if (!st) return;
    updateAccountState(accountId, { saving: true, msg: null });
    try {
      await api.saveAccountColumns(accountId, st.columns);
      updateAccountState(accountId, { msg: t("settings.customColumns.saved") });
      // 重新加载
      const cols = await api.listAccountColumns(accountId);
      updateAccountState(accountId, { columns: cols.sort((a, b) => a.orderIndex - b.orderIndex) });
    } catch (e) {
      updateAccountState(accountId, { msg: String(e) });
    } finally {
      updateAccountState(accountId, { saving: false });
    }
  };

  const startAddCol = (accountId: number) => {
    const st = accountStates[accountId];
    if (!st) return;
    updateAccountState(accountId, {
      editingCol: { index: -1, colKey: genColKey(), colName: "", matchRules: "", orderIndex: st.columns.length },
      ruleChips: [],
      ruleInput: "",
    });
  };

  const startEditCol = (accountId: number, col: AccountColumn, idx: number) => {
    let chips: string[] = [];
    try {
      const arr = JSON.parse(col.matchRules);
      if (Array.isArray(arr)) {
        chips = arr.filter((s): s is string => typeof s === "string").map((s) => s.trim());
      }
    } catch {
      chips = col.matchRules.split(/[,，]/).map((s) => s.trim()).filter((s) => s.length > 0);
    }
    chips = [...new Set(chips.filter((s) => s.length > 0))];
    updateAccountState(accountId, {
      editingCol: { index: idx, colKey: col.colKey, colName: col.colName, matchRules: col.matchRules, orderIndex: col.orderIndex },
      ruleChips: chips,
      ruleInput: "",
    });
  };

  const confirmEditCol = (accountId: number) => {
    const st = accountStates[accountId];
    if (!st?.editingCol) return;
    const { index, colKey, colName, orderIndex } = st.editingCol;
    if (!colKey.trim() || !colName.trim()) return;

    const rulesArr = [...new Set(st.ruleChips.map((s) => s.trim()).filter((s) => s.length > 0))];
    const rulesJson = JSON.stringify(rulesArr);

    const newCol: AccountColumn = {
      id: index >= 0 ? st.columns[index].id : 0,
      accountId,
      colKey: colKey.trim(),
      colName: colName.trim(),
      matchRules: rulesJson,
      orderIndex,
    };

    const updated = index >= 0
      ? st.columns.map((c, i) => (i === index ? newCol : c))
      : [...st.columns, newCol];

    updateAccountState(accountId, { columns: updated, editingCol: null, ruleChips: [], ruleInput: "" });
  };

  const deleteCol = (accountId: number, idx: number) => {
    const st = accountStates[accountId];
    if (!st) return;
    updateAccountState(accountId, { columns: st.columns.filter((_, i) => i !== idx) });
  };

  const cancelEditCol = (accountId: number) => {
    updateAccountState(accountId, { editingCol: null, ruleChips: [], ruleInput: "" });
  };

  const toggleRule = (accountId: number, v: string) => {
    const st = accountStates[accountId];
    if (!st) return;
    const vv = v.trim();
    if (!vv) return;
    const usedElsewhere = new Set<string>();
    const editingIndex = st.editingCol?.index ?? -1;
    st.columns.forEach((col, idx) => {
      if (idx === editingIndex) return;
      parseMatchRules(col.matchRules).forEach((s) => usedElsewhere.add(s));
    });
    if (usedElsewhere.has(vv) && !st.ruleChips.includes(vv)) return;
    updateAccountState(accountId, {
      ruleChips: st.ruleChips.includes(vv) ? st.ruleChips.filter((x) => x !== vv) : [...st.ruleChips, vv],
    });
  };

  const addCustomRule = (accountId: number) => {
    const st = accountStates[accountId];
    if (!st) return;
    const vv = st.ruleInput.trim();
    if (!vv) return;
    toggleRule(accountId, vv);
    updateAccountState(accountId, { ruleInput: "" });
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
            names: projs.map((p: any) => p.name).join("、") || t("settings.diagNone"),
          }) +
          "\n" +
          t("settings.diagStatuses", { count: res.status_count }) +
          (statusKeys.length ? t("settings.diagExample", { keys: statusKeys.slice(0, 8).join("、") }) : ""),
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
        <h3 className="modal-title" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <span>{t("settings.title")}</span>
          <button className="btn ghost small" onClick={onClose} title={t("btn.cancel")}>✕</button>
        </h3>

        <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
          {( ["base", "columns", "diagnose"] as SettingsTab[]).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setTab(k)}
              className={`chip${tab === k ? " on" : ""}`}
              style={{ padding: "4px 12px", cursor: "pointer" }}
            >
              {t(`settings.tab.${k}`)}
            </button>
          ))}
        </div>

        {/* 基础设置 */}
        <div style={{ display: tab === "base" ? "block" : "none" }}>
          <div className="field">
            <label>{t("settings.language")}</label>
            <select className="select" value={mode} onChange={(e) => setMode(e.target.value as LangMode)}>
              <option value="auto">{t("settings.langAuto")}</option>
              <option value="zh-CN">{t("settings.langZh")}</option>
              <option value="en-US">{t("settings.langEn")}</option>
            </select>
          </div>

          <div className="field">
            <label>{t("settings.syncInterval")}</label>
            <div className="row">
              <input className="input" type="number" min={5} value={minutes} onChange={(e) => setMinutes(Math.max(5, Number(e.target.value) || 5))} />
              <span className="muted">{t("unit.minutes")}</span>
            </div>
            <div className="presets">
              {PRESETS.map((p) => (
                <button key={p} className={`chip${minutes === p ? " on" : ""}`} onClick={() => setMinutes(p)}>
                  {t("settings.presetMinutes", { n: p })}
                </button>
              ))}
            </div>
            <div className="muted small">{t("settings.intervalHint")}</div>
          </div>

          <div className="field">
            <label>{t("settings.ghPathLabel")}</label>
            <input className="input wide" placeholder={t("settings.ghPathPlaceholder")} value={ghPath} onChange={(e) => setGhPath(e.target.value)} />
            <div className="muted small">{t("settings.ghPathHint")}</div>
          </div>

          <div className="field readonly">
            <label>{t("settings.orgLabel")}</label>
            <div className="muted">{settings.org}{t("settings.orgHint")}</div>
          </div>

          <div className="field readonly">
            <label>{t("settings.dbLabel")}</label>
            <div className="muted small path">{settings.dbPath}</div>
          </div>

          {err && <div className="banner error">{err}</div>}
        </div>

        {/* 诊断 */}
        <div style={{ display: tab === "diagnose" ? "block" : "none" }}>
          <div className="field">
            <label>{t("settings.projectDiag")}</label>
            <div className="row" style={{ marginTop: 4 }}>
              <select className="select" value={diagAccountId ?? ""} onChange={(e) => { const id = Number(e.target.value); setDiagAccountId(id); void loadProjects(id); }}>
                {settings.accounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.label}{a.isDefault ? " ★" : ""}</option>
                ))}
              </select>
              <button className="btn" onClick={() => { void diagnoseProject(); if (diagAccountId) void loadProjects(diagAccountId); }} disabled={diagBusy || settings.accounts.length === 0}>
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
              <div className={`banner ${diagMsg.ok ? "ok" : "error"} inline diag-banner`}>{diagMsg.text}</div>
            )}
          </div>
        </div>

        {/* 自定义列映射 - 平铺卡片 */}
        <div style={{ display: tab === "columns" ? "block" : "none" }}>
          <div className="field">
            <label>{t("settings.boardModeTitle")}</label>
            <div className="muted small" style={{ marginBottom: 8 }}>{t("settings.boardModeDesc")}</div>
          </div>

          <div className="account-cards" style={{ display: "flex", flexDirection: "column", gap: 12, maxHeight: "calc(100vh - 260px)", overflowY: "auto" }}>
            {settings.accounts.map((acct) => (
              <AccountCard
                key={acct.id}
                account={acct}
                state={accountStates[acct.id]}
                t={t}
                onBoardModeChange={async (mode: BoardMode) => {
                  await api.setAccountBoardMode(acct.id, mode);
                }}
                onStartAddCol={() => startAddCol(acct.id)}
                onStartEditCol={(col, idx) => startEditCol(acct.id, col, idx)}
                onConfirmEditCol={() => confirmEditCol(acct.id)}
                onDeleteCol={(idx) => deleteCol(acct.id, idx)}
                onCancelEditCol={() => cancelEditCol(acct.id)}
                onSaveColumns={() => saveColumns(acct.id)}
                onToggleRule={(v) => toggleRule(acct.id, v)}
                onAddCustomRule={() => addCustomRule(acct.id)}
                onUpdateEditingCol={(patch) => {
                  const st = accountStates[acct.id];
                  if (st?.editingCol) updateAccountState(acct.id, { editingCol: { ...st.editingCol, ...patch } });
                }}
                onUpdateRuleInput={(v) => updateAccountState(acct.id, { ruleInput: v })}
              />
            ))}
          </div>
        </div>

        <div className="modal-actions" style={{ display: tab === "base" ? "flex" : "none" }}>
          <button className="btn" onClick={onClose}>{t("btn.cancel")}</button>
          <button className="btn primary" onClick={save} disabled={saving}>{saving ? t("btn.saving") : t("btn.save")}</button>
        </div>
      </div>
    </div>
  );
}

// 单个账号卡片组件
function AccountCard({
  account,
  state,
  t,
  onBoardModeChange,
  onStartAddCol,
  onStartEditCol,
  onConfirmEditCol,
  onDeleteCol,
  onCancelEditCol,
  onSaveColumns,
  onToggleRule,
  onAddCustomRule,
  onUpdateEditingCol,
  onUpdateRuleInput,
}: {
  account: Account;
  state: AccountEditState | undefined;
  t: (key: string) => string;
  onBoardModeChange: (mode: BoardMode) => Promise<void>;
  onStartAddCol: () => void;
  onStartEditCol: (col: AccountColumn, idx: number) => void;
  onConfirmEditCol: () => void;
  onDeleteCol: (idx: number) => void;
  onCancelEditCol: () => void;
  onSaveColumns: () => void;
  onToggleRule: (v: string) => void;
  onAddCustomRule: () => void;
  onUpdateEditingCol: (patch: Partial<{ colName: string; colKey: string }>) => void;
  onUpdateRuleInput: (v: string) => void;
}) {
  const [boardMode, setBoardMode] = useState<BoardMode>(account.boardMode ?? "project");

  const handleBoardModeChange = async (mode: BoardMode) => {
    setBoardMode(mode);
    await onBoardModeChange(mode);
  };

  if (!state) return null;

  const usedElsewhere = new Set<string>();
  const editingIndex = state.editingCol?.index ?? -1;
  state.columns.forEach((col, idx) => {
    if (idx === editingIndex) return;
    parseMatchRules(col.matchRules).forEach((s) => usedElsewhere.add(s));
  });

  return (
    <div className="account-config-card" style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12 }}>
      <div className="account-config-header" style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span style={{ fontWeight: 600 }}>{account.label}</span>
        {account.isDefault && <span title="默认账号">★</span>}
        <span style={{ marginLeft: "auto" }} className="muted small">看板模式:</span>
        <select className="select" value={boardMode} onChange={(e) => void handleBoardModeChange(e.target.value as BoardMode)} style={{ width: "auto" }}>
          <option value="project">{t("settings.boardModeProject")}</option>
          <option value="custom">{t("settings.boardModeCustom")}</option>
        </select>
      </div>

      {boardMode === "custom" && (
        <div className="account-config-columns" style={{ marginTop: 8, borderTop: "1px solid var(--border)", paddingTop: 8 }}>
          {/* 列编辑表单 */}
          {state.editingCol && (
            <div className="col-editor" style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 10, marginBottom: 8 }}>
              <div className="row" style={{ gap: 6, marginBottom: 6 }}>
                <div style={{ flex: 1 }}>
                  <label className="small">{t("settings.customColumns.colName")}</label>
                  <input className="input" placeholder="待开发" value={state.editingCol.colName} onChange={(e) => onUpdateEditingCol({ colName: e.target.value })} />
                </div>
              </div>
              <div style={{ marginBottom: 6 }}>
                <label className="small">{t("settings.customColumns.matchRules")}</label>
                {state.availableStatuses.length > 0 ? (
                  <div style={{ marginTop: 4 }}>
                    {state.availableStatuses.map((s) => {
                      const on = state.ruleChips.includes(s);
                      const disabled = usedElsewhere.has(s) && !on;
                      return (
                        <button key={`st_${s}`} type="button" onClick={() => !disabled && onToggleRule(s)} disabled={disabled}
                          title={disabled ? t("settings.customColumns.usedElsewhere") : undefined}
                          style={{ padding: "3px 10px", margin: "0 6px 6px 0", borderRadius: 999, border: "1px solid var(--border)", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.45 : 1, background: on ? "var(--accent, #4f6ef7)" : "transparent", color: on ? "#fff" : "inherit" }}>
                          {s}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className="muted small" style={{ marginBottom: 4 }}>{t("settings.customColumns.noStatus")}</div>
                )}
                <div className="row" style={{ gap: 6, marginTop: 6 }}>
                  <input className="input" style={{ flex: 1 }} placeholder={t("settings.customColumns.otherValue")} value={state.ruleInput} onChange={(e) => onUpdateRuleInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onAddCustomRule(); } }} />
                  <button className="btn ghost small" onClick={onAddCustomRule}>{t("settings.customColumns.addRule")}</button>
                </div>
                {state.ruleChips.length > 0 && (
                  <div style={{ marginTop: 6 }}>
                    <span className="muted small">{t("settings.customColumns.selected")}: </span>
                    {state.ruleChips.map((r) => (
                      <button key={`rule_${r}`} type="button" onClick={() => onToggleRule(r)} title={t("settings.customColumns.remove")} className="chip" style={{ marginRight: 4, cursor: "pointer" }}>{r} ✕</button>
                    ))}
                  </div>
                )}
              </div>
              <div className="row" style={{ gap: 6 }}>
                <button className="btn primary" onClick={onConfirmEditCol} disabled={!state.editingCol.colName.trim()}>{t("btn.done")}</button>
                <button className="btn" onClick={onCancelEditCol}>{t("btn.cancel")}</button>
              </div>
            </div>
          )}

          {/* 列列表 */}
          {state.columns.length === 0 && !state.editingCol && (
            <div className="muted small">{t("settings.customColumns.empty")}</div>
          )}
          {state.columns.map((col, idx) => (
            <div key={idx} className="col-row" style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", borderBottom: "1px solid var(--border)" }}>
              <span className="chip" style={{ minWidth: 24, textAlign: "center" }}>{idx}</span>
              <span style={{ flex: 1, fontWeight: 500 }}>{col.colName}</span>
              <span className="muted small" style={{ flex: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {(() => { try { const arr = JSON.parse(col.matchRules); return Array.isArray(arr) ? arr.join(", ") : col.matchRules; } catch { return col.matchRules; } })()}
              </span>
              <button className="btn ghost small" onClick={() => onStartEditCol(col, idx)}>{t("settings.customColumns.edit")}</button>
              <button className="btn ghost small" onClick={() => onDeleteCol(idx)}>{t("settings.customColumns.delete")}</button>
            </div>
          ))}

          {/* 操作按钮 */}
          <div className="row" style={{ gap: 6, marginTop: 8 }}>
            <button className="btn" onClick={onStartAddCol}>+ {t("settings.customColumns.add")}</button>
            <button className="btn primary" onClick={onSaveColumns} disabled={state.saving}>{state.saving ? t("settings.loading") : t("btn.save")}</button>
            {state.msg && <span className={`muted small ${state.msg === t("settings.customColumns.saved") ? "ok" : "error"}`}>{state.msg}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
