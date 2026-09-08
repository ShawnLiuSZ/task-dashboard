import { useEffect } from "react";
import { useI18n } from "../i18n";

interface Props {
  /** 确认提示语。 */
  message: string;
  /** 确认按钮文案；默认 btn.confirm。 */
  confirmLabel?: string;
  /** 取消按钮文案；默认 btn.cancel。 */
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/** v0.3.51 (#160)：应用内确认弹窗。
 * Tauri v2 的 WebView 原生不支持 window.confirm（macOS 静默返回 false），
 * 二次确认必须用应用内 modal，替代所有 confirm() / window.confirm() 调用。
 */
export default function ConfirmDialog({
  message,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
}: Props) {
  const { t } = useI18n();

  // Esc 关闭等价于取消
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="modal-mask" onClick={onCancel}>
      <div
        className="modal confirm-modal"
        onClick={(e) => e.stopPropagation()}
        role="alertdialog"
        aria-modal="true"
        aria-label={message}
      >
        <p className="confirm-message">{message}</p>
        <div className="modal-actions">
          <button className="btn" onClick={onCancel}>
            {cancelLabel ?? t("btn.cancel")}
          </button>
          <button className="btn primary danger" onClick={onConfirm} autoFocus>
            {confirmLabel ?? t("btn.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
