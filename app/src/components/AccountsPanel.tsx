import { useEffect, useRef, useState } from "react";
import { api, openExternal } from "../api";
import { useI18n } from "../i18n";
import { formatCountdownSeconds } from "../utils/format";
import type { Account, DeviceLoginStart, Settings } from "../types";

interface Props {
  settings: Settings;
  onClose: () => void;
  onAccountsChanged?: () => void;
}

export default function AccountsPanel({
  settings,
  onClose,
  onAccountsChanged,
}: Props) {
  const { t } = useI18n();
  const [accounts, setAccounts] = useState<Account[]>(settings.accounts);
  // 账号数据来自父级 settings：授权成功 / 设默认后父级会刷新 settings，
  // 必须把 props 变化同步回本地 state，否则只有重新挂载（关闭重开 modal）才看得到新账号。
  // 全量替换而非追加，天然避免重复项。
  useEffect(() => {
    setAccounts(settings.accounts);
  }, [settings.accounts]);
  const [addingAccount, setAddingAccount] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newOrg, setNewOrg] = useState("");
  const [accountMsg, setAccountMsg] = useState<string | null>(null);
  const [testingAccountId, setTestingAccountId] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [oauthPhase, setOauthPhase] = useState<"idle" | "code" | "success">("idle");
  const [oauthStart, setOauthStart] = useState<DeviceLoginStart | null>(null);
  const [oauthMsg, setOauthMsg] = useState<string | null>(null);
  const [oauthBusy, setOauthBusy] = useState(false);
  const oauthRunRef = useRef(0);
  const [oauthRemaining, setOauthRemaining] = useState(0);

  useEffect(() => {
    if (oauthPhase !== "code" || !oauthStart) {
      setOauthRemaining(0);
      return;
    }
    const runId = oauthRunRef.current;
    setOauthRemaining(oauthStart.expiresIn);
    const timer = setInterval(() => {
      if (oauthRunRef.current !== runId) {
        clearInterval(timer);
        return;
      }
      setOauthRemaining((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [oauthPhase, oauthStart]);

  const deleteAccount = async (id: number) => {
    if (!confirm(t("settings.deleteConfirm"))) return;
    setErr(null);
    try {
      await api.deleteAccount(id);
      setAccounts((prev) => prev.filter((a) => a.id !== id));
      onAccountsChanged?.();
    } catch (e) {
      setErr(String(e));
    }
  };

  const testAccount = async (id: number) => {
    setTestingAccountId(id);
    setAccountMsg(null);
    setErr(null);
    try {
      const res = await api.testAccountPat(id);
      setAccountMsg(t("settings.testOk", { id, login: res.login }));
    } catch (e) {
      setAccountMsg(null);
      setErr(String(e));
    } finally {
      setTestingAccountId(null);
    }
  };

  const setDefault = async (id: number) => {
    setErr(null);
    try {
      await api.setDefaultAccount(id);
      onAccountsChanged?.();
      setAccountMsg(t("settings.defaultSet"));
    } catch (e) {
      setAccountMsg(null);
      setErr(String(e));
    }
  };

  const runDeviceLogin = async (label: string, org: string) => {
    setOauthBusy(true);
    setOauthMsg(null);
    setErr(null);
    const runId = ++oauthRunRef.current;
    try {
      const st = await api.deviceLoginStart("");
      setOauthStart(st);
      setOauthPhase("code");
      openExternal(st.verificationUriComplete);
      let interval = st.interval;
      while (oauthRunRef.current === runId) {
        await new Promise((r) => setTimeout(r, interval * 1000));
        if (oauthRunRef.current !== runId) return;
        const res = await api.deviceLoginPoll("", st.deviceCode, org, label);
        if (res.status === "pending") continue;
        if (res.status === "slow_down") {
          interval += 5;
          continue;
        }
        if (res.status === "success") {
          setOauthPhase("success");
          setOauthMsg(t("settings.loginSuccess", { login: res.login }));
          onAccountsChanged?.();
          return;
        }
        setOauthPhase("idle");
        setOauthMsg(res.message || t("settings.loginFailed"));
        return;
      }
    } catch (e) {
      setOauthPhase("idle");
      setOauthMsg(String(e));
    } finally {
      if (oauthRunRef.current === runId) setOauthBusy(false);
    }
  };

  const cancelDeviceLogin = () => {
    oauthRunRef.current += 1;
    setOauthPhase("idle");
    setOauthStart(null);
    setOauthMsg(null);
    setOauthBusy(false);
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">{t("accounts.title")}</h3>

        <div className="field">
          <label>{t("settings.accountsTitle")}</label>
          {accounts.length === 0 ? (
            <div className="muted small">{t("settings.noAccounts")}</div>
          ) : (
            <div className="account-list">
              {accounts.map((a) => (
                <div key={a.id} className="account-row">
                  <div className="account-info">
                    <div className="account-row-head">
                      <strong>{a.label}</strong>
                      {a.isDefault && (
                        <span className="default-tag" title={t("settings.defaultTitle")}>
                          {t("settings.defaultTag")}
                        </span>
                      )}
                    </div>
                    <div className="muted small">
                      @{a.login}{a.org ? ` · ${a.org}` : ""} ·{" "}
                      {a.hasPat ? (
                        t("settings.authorized")
                      ) : (
                        <span className="warn">{t("settings.unauthorized")}</span>
                      )}
                    </div>
                  </div>
                  <div className="account-row-actions">
                    <button
                      className="btn small"
                      onClick={() => void testAccount(a.id)}
                      disabled={!a.hasPat || testingAccountId === a.id}
                      title={t("settings.testTitle")}
                    >
                      {testingAccountId === a.id ? t("settings.testing") : t("settings.test")}
                    </button>
                    {!a.isDefault && (
                      <button
                        className="btn small"
                        onClick={() => void setDefault(a.id)}
                        title={t("settings.setDefaultTitle")}
                      >
                        {t("settings.setDefault")}
                      </button>
                    )}
                    <button
                      className="btn small ghost"
                      onClick={() => void deleteAccount(a.id)}
                      disabled={a.isDefault}
                      title={
                        a.isDefault
                          ? t("settings.cantDeleteDefault")
                          : t("settings.deleteTitle")
                      }
                    >
                      {t("btn.delete")}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {!addingAccount ? (
            <button
              className="btn"
              style={{ marginTop: 8 }}
              onClick={() => setAddingAccount(true)}
            >
              {t("settings.addAccount")}
            </button>
          ) : (
            <div className="account-form">
              {oauthPhase === "idle" && (
                <>
                  <input
                    className="input wide"
                    placeholder={t("settings.labelPlaceholder")}
                    value={newLabel}
                    onChange={(e) => setNewLabel(e.target.value)}
                  />
                  <input
                    className="input wide"
                    placeholder={t("settings.orgPlaceholder")}
                    value={newOrg}
                    onChange={(e) => setNewOrg(e.target.value)}
                  />
                  <div className="row" style={{ marginTop: 6 }}>
                    <button
                      className="btn primary"
                      onClick={() => void runDeviceLogin(newLabel, newOrg)}
                      disabled={oauthBusy}
                    >
                      {oauthBusy ? t("settings.openingBrowser") : t("settings.authorizeLogin")}
                    </button>
                    <button
                      className="btn"
                      onClick={() => {
                        oauthRunRef.current += 1;
                        setAddingAccount(false);
                        setNewLabel("");
                        setNewOrg("");
                      }}
                    >
                      {t("btn.cancel")}
                    </button>
                  </div>
                  <div className="muted small" style={{ marginTop: 6 }}>
                    {t("settings.deviceFlowHint")}
                  </div>
                </>
              )}

              {oauthPhase === "code" && oauthStart && (
                <div className="device-flow">
                  <div className="muted small">{t("settings.enterCode")}</div>
                  <div className="user-code" title={t("settings.clickCopy")}>
                    {oauthStart.userCode}
                  </div>
                  <div className="row" style={{ marginTop: 8 }}>
                    <button
                      className="btn"
                      onClick={() => openExternal(oauthStart.verificationUriComplete)}
                    >
                      {t("settings.reopenAuth")}
                    </button>
                    <button className="btn ghost" onClick={cancelDeviceLogin}>
                      {t("settings.cancelLogin")}
                    </button>
                  </div>
                  <div className="muted small" style={{ marginTop: 6 }}>
                    {t("settings.waitingAuth", { time: formatCountdownSeconds(oauthRemaining) })}
                  </div>
                </div>
              )}

              {oauthPhase === "success" && (
                <div className="device-flow">
                  <div className="banner ok inline">{oauthMsg}</div>
                  <button
                    className="btn"
                    style={{ marginTop: 8 }}
                    onClick={() => {
                      setOauthPhase("idle");
                      setOauthStart(null);
                      setOauthMsg(null);
                      setAddingAccount(false);
                      setNewLabel("");
                      setNewOrg("");
                    }}
                  >
                    {t("btn.done")}
                  </button>
                </div>
              )}

              {oauthMsg && oauthPhase === "idle" && (
                <div className="banner error inline">{oauthMsg}</div>
              )}
            </div>
          )}
          <div className="muted small" style={{ marginTop: 6 }}>
            {t("settings.accountsHint")}
          </div>
          {accountMsg && <div className="banner ok inline">{accountMsg}</div>}
        </div>

        {err && <div className="banner error">{err}</div>}

        <div className="modal-actions">
          <button className="btn primary" onClick={onClose}>
            {t("btn.done")}
          </button>
        </div>
      </div>
    </div>
  );
}
