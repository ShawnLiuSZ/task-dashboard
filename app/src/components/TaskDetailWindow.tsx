import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { api } from '../api';
import { useI18n } from '../i18n';
import type { ProjectStatus, Task } from '../types';
import DetailPanel from './DetailPanel';

/**
 * #526：任务详情的**独立窗口**。
 *
 * ## 为什么要有独立窗
 *
 * 详情面板（modal）原先**每次打开都实时拉一次 GitHub**（`fetch_task_detail_live`），
 * 而本地库**没有** issue body / timeline 列（正文只在实时拉取里）⇒
 * ① 打开面板要等网络；② 面板里的信息其实**装不下**（正文 + 时间线 + PR 提交 + 评论）。
 *
 * ⇒ 拆成两种形态：
 * - **modal**（主窗口）：`live={false}` ⇒ **零 GitHub 请求**，只做「操作面板」
 *   （状态行 / 指派 / 标签 / 会话 / 交接 / 本地评论列表）；
 * - **独立窗**（本组件）：`live` 打开 ⇒ **完整信息**（正文 / 时间线 / PR 提交 / 实时评论）。
 *
 * ## 任务标识怎么传进来
 *
 * Rust 侧 `open_task_detail_window` 用 `initialization_script` 在页面脚本执行**之前**
 * 注入 `window.__TASK_DETAIL__` ⇒ **无竞态**（窗口一加载就能读到），
 * 且不依赖 URL query（dev / prod 的 URL 解析规则不同）。
 */

/** 与 Rust 侧 `open_task_detail_window` 注入的 `window.__TASK_DETAIL__` 对应。 */
export interface TaskDetailTarget {
  issueKey: string;
  accountId: number;
}

declare global {
  interface Window {
    __TASK_DETAIL__?: TaskDetailTarget;
  }
}

export default function TaskDetailWindow() {
  const { t } = useI18n();
  const [task, setTask] = useState<Task | null>(null);
  const [projectStatuses, setProjectStatuses] = useState<ProjectStatus[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const target = window.__TASK_DETAIL__;
    if (!target) {
      setErr(t('detailWindow.missingTarget'));
      return;
    }
    let cancelled = false;
    Promise.all([
      api.getTask(target.issueKey, target.accountId),
      api.listProjectStatuses(target.accountId).catch(() => [] as ProjectStatus[]),
    ])
      // ⚠️ 别名 `loaded` 而非 `t` —— `t` 是 i18n 的翻译函数（同名会遮蔽它）。
      .then(([loaded, statuses]) => {
        if (cancelled) return;
        if (!loaded) {
          setErr(t('detailWindow.taskNotFound'));
          return;
        }
        setTask(loaded);
        setProjectStatuses(statuses);
      })
      .catch((e) => {
        if (!cancelled) setErr(String(e));
      });
    return () => {
      cancelled = true;
    };
    // ⚠️ 只在挂载时取一次：窗口与任务一一对应（label 含 issue_key + account_id）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (err) {
    return (
      <div className="detail-window-error">
        <p>{err}</p>
        <button className="btn" onClick={() => void getCurrentWindow().close()}>
          {t('btn.close')}
        </button>
      </div>
    );
  }

  if (!task) {
    // 加载态：骨架屏意义不大（很快），给一句提示即可。
    return <div className="detail-window-error muted">{t('detailWindow.loading')}</div>;
  }

  return (
    <DetailPanel
      task={task}
      projectStatuses={projectStatuses}
      // #526：独立窗是「完整详情」⇒ 开启实时拉取。
      live
      variant="window"
      onClose={() => void getCurrentWindow().close()}
      onChanged={() => {
        // 状态写回后刷新本地那条（GitHub Project Status / 认领等会改 tasks 表）。
        void api.getTask(task.issueKey, task.accountId).then((t) => {
          if (t) setTask(t);
        });
      }}
    />
  );
}
