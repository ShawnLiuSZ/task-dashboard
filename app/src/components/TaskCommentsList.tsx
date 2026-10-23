import { openExternal } from '../api';
import { type TaskComment } from '../types';
import { fmtTime, useI18n } from '../i18n';

/**
 * #472：详情面板里的**评论链接列表**（倒序：最新在前）。
 *
 * ## 为什么单独成组件
 *
 * 详情面板的其它部分（PR 按钮、关联 issue）都直接写在 `DetailPanel.tsx` 里，
 * 但评论列表是**数据驱动**的（按需拉取 ⇒ 有「加载中 / 空 / 有内容」三态），
 * 且**倒序**是本功能的核心语义 ⇒ 值得独立成组件：
 *
 * - 渲染逻辑可被**服务端渲染断言**覆盖（`renderToStaticMarkup`）——
 *   本仓前端测试跑在 node 环境（无 DOM、无 jsdom）⇒ `useEffect` 不执行，
 *   放在 `DetailPanel` 内部的拉取结果**测不到**；
 * - 「最新在前」的顺序断言有个明确的落点，不必去解析整个详情面板的 HTML。
 *
 * ## 顺序契约
 *
 * **倒序由后端保证**（`db::load_task_comments` 的
 * `ORDER BY created_at DESC, comment_id DESC`）⇒ 本组件**不再二次排序**，
 * 避免两处排序口径打架（前端重排会掩盖后端排序写反的问题）。
 *
 * ⚠️ 渲染顺序 = 传入顺序 ⇒ 测试直接断言「第 1 项是最新的那条」。
 */
interface Props {
  /** 全部评论（后端已按倒序返回：最新在前）。 */
  comments: TaskComment[];
  /** 正在拉取（列表尚为空时的占位态）。 */
  loading?: boolean;
}

export default function TaskCommentsList({ comments, loading = false }: Props) {
  const { t, lang } = useI18n();
  // 列表为空且不在加载 ⇒ 整节不渲染（不显示空标题）。
  if (comments.length === 0 && !loading) return null;

  return (
    <section className="detail-block">
      <div className="block-title">{t('detail.commentsTitle', { n: comments.length })}</div>
      {comments.length === 0 ? (
        <div className="muted small">{t('detail.commentsLoading')}</div>
      ) : (
        <ul className="link-list">
          {comments.map((c) => (
            <li key={c.url} className="link-line">
              <span className="link-ref">{c.author ? `@${c.author}` : '-'}</span>
              <span className="muted small">{c.createdAt ? fmtTime(c.createdAt, lang) : '-'}</span>
              <button className="btn ghost small inline" onClick={() => openExternal(c.url)}>
                {t('detail.openInBrowser')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
