import { useI18n } from '../i18n';
import { useWindowEscLayer } from '../utils/useEscLayer';

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

  // Esc 关闭等价于取消。
  // #329：确认框一定叠在某个面板之上，必须注册为「最上层」——否则面板的
  // Esc 监听器会收到同一个事件，一次 Esc 把确认框和面板一起关掉。
  // #344：改走 useWindowEscLayer —— 层注册只发生一次（`onCancel` 每次渲染都是
  // 新引用，放进 effect 依赖会让层级在某次父重渲染时被父子整体重排而颠倒）。
  useWindowEscLayer(onCancel);

  return (
    <div className="modal-mask confirm-mask" onClick={onCancel}>
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
            {cancelLabel ?? t('btn.cancel')}
          </button>
          <button className="btn primary danger" onClick={onConfirm} autoFocus>
            {confirmLabel ?? t('btn.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
