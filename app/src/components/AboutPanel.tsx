import { useCallback, useEffect, useState } from "react";
import { api, onUpdateProgress, openExternal } from "../api";
import { useI18n } from "../i18n";

interface Props {
  onClose: () => void;
}

/**
 * idle = 尚未检查（按钮可点）；loading = 正在检查（防重复点击）。
 * #231 扩展 available / installing / installed 三个阶段，用于承载应用内更新流程。
 */
type State =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "upToDate"; current: string }
  | {
      phase: "available";
      version: string;
      current: string;
      notes: string;
      /** 非空表示应用内更新不可用，退化为前往 Releases 手动下载。 */
      manualUrl?: string;
    }
  | { phase: "installing"; percent: number | null }
  | { phase: "installed"; version: string }
  | { phase: "error"; message: string };

/** 按当前安装平台返回 taskboard 二进制的默认路径（与 README 一致）。 */
function getMcpCommand(): string {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("mac")) {
    return "/Applications/TaskBoard.app/Contents/MacOS/taskboard";
  }
  if (ua.includes("win")) {
    return "C:\\Program Files\\TaskBoard\\taskboard.exe";
  }
  // Linux / 其他
  return "/usr/bin/taskboard";
}

/** MCP 接入配置片段（与 README 一致，代码块非翻译）。 */
function buildMcpSnippet(): string {
  const cmd = getMcpCommand();
  return `{
  "mcpServers": {
    "taskboard": {
      "type": "stdio",
      "command": ${JSON.stringify(cmd)},
      "args": ["mcp"]
    }
  }
}`;
}

/** v0.3.19+「关于」弹窗：展示当前版本号 + 检查更新入口。 */
export default function AboutPanel({ onClose }: Props) {
  const { t } = useI18n();
  const [version, setVersion] = useState<string>("");
  const [state, setState] = useState<State>({ phase: "idle" });

  const loadVersion = useCallback(async () => {
    try {
      setVersion(await api.getAppVersion());
    } catch {
      setVersion("?");
    }
  }, []);

  /**
   * #231：优先走应用内更新通道（tauri-plugin-updater）。
   *
   * 该通道不可用时（尚未配置签名公钥、或 Releases 上还没有 latest.json）回退为
   * 纯版本号对比 + 跳转 Releases 手动下载，避免「检查更新」整体失效。
   */
  const check = useCallback(async () => {
    setState({ phase: "loading" });
    try {
      const u = await api.checkAppUpdate();
      if (!u.error) {
        setState(
          u.available
            ? {
                phase: "available",
                version: u.version,
                current: u.current,
                notes: u.notes,
              }
            : { phase: "upToDate", current: u.current },
        );
        return;
      }

      const d = await api.checkLatestRelease();
      if (d.error) {
        setState({ phase: "error", message: d.error });
      } else if (d.upToDate) {
        setState({ phase: "upToDate", current: d.current });
      } else {
        setState({
          phase: "available",
          version: d.latest,
          current: d.current,
          notes: "",
          manualUrl: d.url,
        });
      }
    } catch (e) {
      setState({ phase: "error", message: String(e) });
    }
  }, []);

  /** #231：下载并安装更新，完成后引导用户重启生效。 */
  const install = useCallback(async (target: string) => {
    setState({ phase: "installing", percent: null });
    try {
      await api.installAppUpdate();
      setState({ phase: "installed", version: target });
    } catch (e) {
      setState({ phase: "error", message: String(e) });
    }
  }, []);

  // 打开弹窗时先拉一次当前版本（不自动联网检查）。
  useEffect(() => {
    void loadVersion();
  }, [loadVersion]);

  // #231：订阅下载进度，仅在 installing 阶段刷新百分比。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void onUpdateProgress((p) => {
      const percent =
        p.total && p.total > 0
          ? Math.min(100, Math.floor((p.downloaded / p.total) * 100))
          : null;
      setState((prev) =>
        prev.phase === "installing" ? { phase: "installing", percent } : prev,
      );
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  const busy = state.phase === "loading" || state.phase === "installing";

  return (
    <div className="modal-mask" onClick={onClose}>
      <div
        className="modal about-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t("about.title")}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
      >
        <h3 className="modal-title">{t("about.title")}</h3>

        <div className="about-body">
          <div className="field readonly">
            <label>{t("about.versionLabel")}</label>
            <div className="muted small">v{version}</div>
          </div>

          <p className="muted small about-intro">{t("about.intro")}</p>

          <section className="about-section">
            <h4>{t("about.capsTitle")}</h4>
            <ul className="about-caps">
              <li>{t("about.cap.kanban")}</li>
              <li>{t("about.cap.sync")}</li>
              <li>{t("about.cap.session")}</li>
              <li>{t("about.cap.i18n")}</li>
            </ul>
          </section>

          <section className="about-section">
            <h4>{t("about.dataTitle")}</h4>
            <code className="about-data-path">{t("about.dataPath")}</code>
          </section>

          <section className="about-section">
            <h4>{t("about.mcpTitle")}</h4>
            <p className="muted small">{t("about.mcpDesc")}</p>
            <pre className="about-code">{buildMcpSnippet()}</pre>
            <p className="muted small">{t("about.mcpFallback")}</p>
          </section>

          <div className="about-repo-row" style={{ marginTop: 4 }}>
            <span className="muted small">{t("about.repoPath")}</span>
            <button
              className="about-repo-link"
              title="https://github.com/ShawnLiuSZ/task-dashboard"
              onClick={() => openExternal("https://github.com/ShawnLiuSZ/task-dashboard")}
            >
              ShawnLiuSZ/task-dashboard ↗
            </button>
          </div>

          {state.phase === "loading" && (
            <div className="about-status">{t("about.checking")}</div>
          )}

          {state.phase === "upToDate" && (
            <div className="about-status up-to-date">
              {"✅"} {t("about.upToDate", { version: state.current })}
            </div>
          )}

          {state.phase === "available" && (
            <div className="about-status has-update">
              {"✨"}{" "}
              {t("about.updateAvailable", {
                latest: state.version,
                current: state.current,
              })}
              {state.notes && (
                <p className="muted small" style={{ whiteSpace: "pre-wrap" }}>
                  {state.notes}
                </p>
              )}
              {state.manualUrl ? (
                <button
                  className="btn primary"
                  style={{ marginTop: 6 }}
                  onClick={() => openExternal(state.manualUrl as string)}
                >
                  {t("about.download")} ↗
                </button>
              ) : (
                <button
                  className="btn primary"
                  style={{ marginTop: 6 }}
                  onClick={() => void install(state.version)}
                >
                  {t("about.install")}
                </button>
              )}
            </div>
          )}

          {state.phase === "installing" && (
            <div className="about-status">
              {state.percent === null
                ? t("about.installing")
                : t("about.progress", { percent: state.percent })}
            </div>
          )}

          {state.phase === "installed" && (
            <div className="about-status has-update">
              {"✅"} {t("about.installed", { version: state.version })}
              <button
                className="btn primary"
                style={{ marginTop: 6 }}
                onClick={() => void api.restartApp()}
              >
                {t("about.restart")}
              </button>
            </div>
          )}

          {state.phase === "error" && (
            <div className="about-status error">
              {t("about.error", { error: state.message })}
            </div>
          )}
        </div>

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            {t("btn.close")}
          </button>
          <button className="btn primary" onClick={check} disabled={busy}>
            {state.phase === "loading" ? t("about.checking") : t("about.checkUpdate")}
          </button>
        </div>
      </div>
    </div>
  );
}
