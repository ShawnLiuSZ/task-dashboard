import { useCallback, useEffect, useState } from "react";
import { api, openExternal } from "../api";
import { useI18n } from "../i18n";
import type { CheckUpdate } from "../types";

interface Props {
  onClose: () => void;
}

/** idle = 尚未检查（按钮可点）；loading = 正在检查（防重复点击）。 */
type State =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "ok"; data: CheckUpdate }
  | { phase: "error"; message: string };

/** MCP 接入配置片段（与 README 一致，代码块非翻译）。 */
const MCP_SNIPPET = `{
  "mcpServers": {
    "taskboard": {
      "type": "stdio",
      "command": "/Applications/TaskBoard.app/Contents/MacOS/taskboard",
      "args": ["mcp"]
    }
  }
}`;

/** v0.3.19+「关于」弹窗：展示当前版本号 + 检查更新入口。 */
export default function AboutPanel({ onClose }: Props) {
  const { t } = useI18n();
  const [version, setVersion] = useState<string>("");
  const [state, setState] = useState<State>({ phase: "idle" });

  const loadVersion = useCallback(async () => {
    try {
      setVersion(await api.getAppVersion());
    } catch (e) {
      setVersion("?");
    }
  }, []);

  const check = useCallback(async () => {
    setState({ phase: "loading" });
    try {
      const d = await api.checkLatestRelease();
      if (d.error) {
        setState({ phase: "error", message: d.error });
      } else {
        setState({ phase: "ok", data: d });
      }
    } catch (e) {
      setState({ phase: "error", message: String(e) });
    }
  }, []);

  // 打开弹窗时先拉一次当前版本（不自动联网检查）。
  useEffect(() => {
    void loadVersion();
  }, [loadVersion]);

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal about-modal" onClick={(e) => e.stopPropagation()}>
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
            <pre className="about-code">{MCP_SNIPPET}</pre>
            <p className="muted small">{t("about.mcpWorkbuddy")}</p>
            <p className="muted small">{t("about.mcpFallback")}</p>
          </section>

          <div className="about-repo-row" style={{ marginTop: 4 }}>
            <span className="muted small">{t("about.repoPath")}</span>
            <button
              className="about-repo-link"
              title="https://github.com/ShawnLiuSZ/task-dashborad"
              onClick={() => openExternal("https://github.com/ShawnLiuSZ/task-dashborad")}
            >
              ShawnLiuSZ/task-dashborad ↗
            </button>
          </div>

          {state.phase === "loading" && (
            <div className="about-status">{t("about.checking")}</div>
          )}
          {state.phase === "ok" &&
            (state.data.upToDate ? (
              <div className="about-status up-to-date">
                {"✅"} {t("about.upToDate", { version: state.data.current })}
              </div>
            ) : (
              <div className="about-status has-update">
                {"✨"} {t("about.updateAvailable", { latest: state.data.latest, current: state.data.current })}
                {state.data.url && (
                  <button
                    className="btn primary"
                    style={{ marginTop: 6 }}
                    onClick={() => openExternal(state.data.url)}
                  >
                    {t("about.download")} ↗
                  </button>
                )}
              </div>
            ))}
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
          <button className="btn primary" onClick={check} disabled={state.phase === "loading"}>
            {state.phase === "loading" ? t("about.checking") : t("about.checkUpdate")}
          </button>
        </div>
      </div>
    </div>
  );
}