import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useI18n, type LangMode } from "../i18n";
import type { AccountColumn, BoardMode, Settings } from "../types";

interface Props {
  settings: Settings;
  onSaved: (s: Settings) => void;
  onClose: () => void;
}

const PRESETS = [15, 30, 60, 120, 240];

// 自动生成稳定的自定义列标识（col_key 是任务落库的 status 值，需唯一但不需用户输入）
function genColKey(): string {
  return `col_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

// 解析列的 matchRules（JSON 数组或逗号分隔）为去重的 status 字符串数组。
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
  // v0.3.43+：按账号配置「看板列展示方式」
  const [bmAccountId, setBmAccountId] = useState<number | null>(
    settings.activeAccountId || settings.accounts[0]?.id || null,
  );
  const [bmMode, setBmMode] = useState<BoardMode>("project");
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

  // v0.3.40+：自定义列 —— 该账号 Project V2 可选的 status 值（下拉配置用）
  const [availableStatuses, setAvailableStatuses] = useState<string[]>([]);
  // 当前编辑列的已选匹配值 chips
  const [ruleChips, setRuleChips] = useState<string[]>([]);
  // 自由输入追加框
  const [ruleInput, setRuleInput] = useState("");

  // v0.3.41+：设置面板 tab 切换（基础 / 自定义列 / 诊断）
  const [tab, setTab] = useState<SettingsTab>("base");

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

  // 账号切换时加载该项目可选的 Project status 值（供自定义列下拉配置）
  useEffect(() => {
    if (colAccountId == null) {
      setAvailableStatuses([]);
      return;
    }
    api
      .listProjectStatuses(colAccountId)
      .then((list) => setAvailableStatuses([...new Set(list.map((p) => p.name).filter(Boolean))]))
      .catch(() => setAvailableStatuses([]));
  }, [colAccountId]);

  // v0.3.43+：切换账号时，展示方式下拉回显该账号已配置的模式（未配置默认 project）。
  useEffect(() => {
    const acct = settings.accounts.find((a) => a.id === bmAccountId);
    setBmMode(acct?.boardMode ?? "project");
  }, [bmAccountId, settings.accounts]);

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
    // col_key 自动生成，用户无需关心；只填列名 + 匹配 status
    setEditingCol({ index: -1, colKey: genColKey(), colName: "", matchRules: "", orderIndex: columns.length });
    setRuleChips([]);
    setRuleInput("");
  };

  const startEditCol = (col: AccountColumn, idx: number) => {
    // 解析既有 matchRules（JSON 数组或逗号分隔）为 chips
    let chips: string[] = [];
    try {
      const arr = JSON.parse(col.matchRules);
      if (Array.isArray(arr)) {
        chips = arr
          .filter((s): s is string => typeof s === "string")
          .map((s) => s.trim());
      }
    } catch {
      chips = col.matchRules
        .split(/[,，]/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }
    chips = [...new Set(chips.filter((s) => s.length > 0))];
    setRuleChips(chips);
    setRuleInput("");
    setEditingCol({
      index: idx,
      colKey: col.colKey,
      colName: col.colName,
      matchRules: col.matchRules,
      orderIndex: col.orderIndex,
    });
  };

  const confirmEditCol = () => {
    if (!editingCol) return;
    const { index, colKey, colName, orderIndex } = editingCol;
    // 校验：col_key 已自动生成，用户只需填列名
    if (!colKey.trim() || !colName.trim()) return;

    // 已选 chips（去重）直接作为 matchRules 的 JSON 数组
    const rulesArr = [...new Set(ruleChips.map((s) => s.trim()).filter((s) => s.length > 0))];
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
    setRuleChips([]);
    setRuleInput("");
  };

  // v0.3.42+：已被「其它列」选用的 status —— 新建列时这些值不可再选（置灰去重）。
  // 正在编辑的列自身不算重复，允许保留其既有选值（删除则恢复可选）。
  const usedElsewhere = useMemo(() => {
    const used = new Set<string>();
    const editingIndex = editingCol?.index ?? -1;
    columns.forEach((col, idx) => {
      if (idx === editingIndex) return;
      parseMatchRules(col.matchRules).forEach((s) => used.add(s));
    });
    return used;
  }, [columns, editingCol]);

  const toggleRule = (v: string) => {
    const vv = v.trim();
    if (!vv) return;
    // 已被其它列使用的 status 禁止重复添加（本列已选中需允许移除，故放行已选中值）。
    if (usedElsewhere.has(vv) && !ruleChips.includes(vv)) return;
    setRuleChips((prev) => (prev.includes(vv) ? prev.filter((x) => x !== vv) : [...prev, vv]));
  };

  const addCustomRule = () => {
    const vv = ruleInput.trim();
    if (!vv) return;
    toggleRule(vv);
    setRuleInput("");
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

        <div className="field" style={{ display: tab === "base" ? "block" : "none" }}>
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

        <div className="field" style={{ display: tab === "base" ? "block" : "none" }}>
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

        <div className="field" style={{ display: tab === "diagnose" ? "block" : "none" }}>
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

        <div className="field" style={{ display: tab === "columns" ? "block" : "none" }}>
          <label>{t("settings.boardModeTitle")}</label>
          <div className="muted small" style={{ marginBottom: 6 }}>{t("settings.boardModeDesc")}</div>
          <div className="row" style={{ marginTop: 4, marginBottom: 8 }}>
            <select
              className="select"
              value={bmAccountId ?? ""}
              onChange={(e) => setBmAccountId(Number(e.target.value))}
            >
              {settings.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}{a.isDefault ? " ★" : ""}
                </option>
              ))}
            </select>
            <select
              className="select"
              value={bmMode}
              onChange={(e) => {
                const mode = e.target.value as BoardMode;
                if (bmAccountId == null || mode === bmMode) return;
                setBmMode(mode);
                api
                  .setAccountBoardMode(bmAccountId, mode)
                  .catch((err) => setErr(String(err)));
              }}
            >
              <option value="project">{t("settings.boardModeProject")}</option>
              <option value="custom">{t("settings.boardModeCustom")}</option>
            </select>
          </div>
        </div>

        <div className="field" style={{ display: tab === "columns" ? "block" : "none" }}>
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
                {availableStatuses.length > 0 ? (
                  <div style={{ marginTop: 4 }}>
                    {availableStatuses.map((s) => {
                      const on = ruleChips.includes(s);
                      const disabled = usedElsewhere.has(s) && !on;
                      return (
                        <button
                          key={`st_${s}`}
                          type="button"
                          onClick={() => !disabled && toggleRule(s)}
                          disabled={disabled}
                          title={disabled ? t("settings.customColumns.usedElsewhere") : undefined}
                          style={{
                            padding: "3px 10px",
                            margin: "0 6px 6px 0",
                            borderRadius: 999,
                            border: "1px solid var(--border)",
                            cursor: disabled ? "not-allowed" : "pointer",
                            opacity: disabled ? 0.45 : 1,
                            background: on ? "var(--accent, #4f6ef7)" : "transparent",
                            color: on ? "#fff" : "inherit",
                          }}
                        >
                          {s}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className="muted small" style={{ marginBottom: 4 }}>
                    {t("settings.customColumns.noStatus")}
                  </div>
                )}
                <div className="row" style={{ gap: 6, marginTop: 6 }}>
                  <input
                    className="input"
                    style={{ flex: 1 }}
                    placeholder={t("settings.customColumns.otherValue")}
                    value={ruleInput}
                    onChange={(e) => setRuleInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addCustomRule();
                      }
                    }}
                  />
                  <button className="btn ghost small" onClick={addCustomRule}>
                    {t("settings.customColumns.addRule")}
                  </button>
                </div>
                {ruleChips.length > 0 && (
                  <div style={{ marginTop: 6 }}>
                    <span className="muted small">{t("settings.customColumns.selected")}: </span>
                    {ruleChips.map((r) => (
                      <button
                        key={`rule_${r}`}
                        type="button"
                        onClick={() => toggleRule(r)}
                        title={t("settings.customColumns.remove")}
                        className="chip"
                        style={{ marginRight: 4, cursor: "pointer" }}
                      >
                        {r} ✕
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="row" style={{ gap: 6 }}>
                <button className="btn primary" onClick={confirmEditCol} disabled={!editingCol.colName.trim()}>
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

        <div className="field" style={{ display: tab === "base" ? "block" : "none" }}>
          <label>{t("settings.ghPathLabel")}</label>
          <input
            className="input wide"
            placeholder={t("settings.ghPathPlaceholder")}
            value={ghPath}
            onChange={(e) => setGhPath(e.target.value)}
          />
          <div className="muted small">{t("settings.ghPathHint")}</div>
        </div>

        <div className="field readonly" style={{ display: tab === "base" ? "block" : "none" }}>
          <label>{t("settings.orgLabel")}</label>
          <div className="muted">
            {settings.org}
            {t("settings.orgHint")}
          </div>
        </div>

        <div className="field readonly" style={{ display: tab === "base" ? "block" : "none" }}>
          <label>{t("settings.dbLabel")}</label>
          <div className="muted small path">{settings.dbPath}</div>
        </div>

        {err && <div className="banner error" style={{ display: tab === "base" ? "block" : "none" }}>{err}</div>}

        <div className="modal-actions" style={{ display: tab === "base" ? "flex" : "none" }}>
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
