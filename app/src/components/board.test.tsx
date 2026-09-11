import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import Board, { groupTasksByCustomColumns, resolveBoardView } from "./Board";
import TaskCard from "./TaskCard";
import { I18nProvider } from "../i18n";
import type { AccountColumn, ProjectStatus, Task } from "../types";

// 固定中文文案，避免 node 环境下 auto 模式解析不确定（navigator.language 不可用）。
beforeEach(() => {
  vi.stubGlobal("localStorage", {
    getItem: () => "zh-CN",
    setItem: () => {},
    removeItem: () => {},
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const noop = () => {};

function mkTask(partial: Partial<Task> & { issueKey: string }): Task {
  return {
    owner: "ShawnLiuSZ",
    repo: "task-dashboard",
    number: 1,
    title: "",
    url: "",
    issueState: "open",
    ownership: "notassignee",
    status: "todo",
    projectStatus: "",
    assignees: "",
    mentioned: false,
    latestCommentUrl: "",
    prNumber: 0,
    prUrl: "",
    branch: "",
    workBranch: "",
    sessionId: null,
    sessionAgent: null,
    sessionAt: null,
    candidateDone: false,
    handoff: "",
    updatedAt: null,
    accountId: 1,
    ...partial,
  };
}

const cols: AccountColumn[] = [
  { id: 1, accountId: 1, colKey: "Todo", colName: "待办", matchRules: '["待办"]', orderIndex: 0 },
  { id: 2, accountId: 1, colKey: "In Progress", colName: "进行中", matchRules: '["进行中"]', orderIndex: 1 },
];

describe("resolveBoardView (#159)", () => {
  it("custom 模式未配置自定义列时回退到 project 视图", () => {
    expect(resolveBoardView("custom", undefined)).toBe("project");
    expect(resolveBoardView("custom", [])).toBe("project");
  });

  it("custom 模式配置了自定义列时使用 custom 视图", () => {
    expect(resolveBoardView("custom", cols)).toBe("custom");
  });

  it("project / status 模式始终为 project 视图", () => {
    expect(resolveBoardView("project", undefined)).toBe("project");
    expect(resolveBoardView("status", undefined)).toBe("project");
  });

  it("未知模式保留四态列兜底", () => {
    expect(resolveBoardView("unknown" as Task["status"] as never, undefined)).toBe("fourstate");
  });
});

describe("groupTasksByCustomColumns (#159)", () => {
  it("status 命中列 colKey 的任务归入对应组，未命中进 unmatched", () => {
    const tasks = [
      mkTask({ issueKey: "a", status: "Todo" as Task["status"] }),
      mkTask({ issueKey: "b", status: "In Progress" as Task["status"] }),
      mkTask({ issueKey: "c", status: "done" }),
    ];
    const { groups, unmatched } = groupTasksByCustomColumns(tasks, cols);
    expect(groups.get("Todo")).toEqual([tasks[0]]);
    expect(groups.get("In Progress")).toEqual([tasks[1]]);
    expect(unmatched).toEqual([tasks[2]]);
  });

  it("未配置列时全部任务进 unmatched", () => {
    const tasks = [mkTask({ issueKey: "a", status: "todo" })];
    const { groups, unmatched } = groupTasksByCustomColumns(tasks, []);
    expect(groups.size).toBe(0);
    expect(unmatched).toEqual(tasks);
  });

  it("accountColumns 为 undefined 时视为空配置", () => {
    const { groups, unmatched } = groupTasksByCustomColumns([], undefined);
    expect(groups.size).toBe(0);
    expect(unmatched).toEqual([]);
  });
});

describe("Board 渲染（#159）", () => {
  const projectStatuses: ProjectStatus[] = [
    { id: 1, accountId: 1, projectGithubId: "PVT_x", name: "In Progress", orderIndex: 0 },
  ];

  it("custom 模式无自定义列时渲染 project 列，而非四态列", () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <Board
          tasks={[]}
          selected={null}
          onSelect={noop}
          boardMode="custom"
          accountColumns={[]}
          projectStatuses={projectStatuses}
        />
      </I18nProvider>,
    );
    expect(html).toContain("In Progress");
    expect(html).not.toContain("待处理");
  });

  it("custom 模式有自定义列时渲染自定义列头", () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <Board
          tasks={[]}
          selected={null}
          onSelect={noop}
          boardMode="custom"
          accountColumns={cols}
          projectStatuses={[]}
        />
      </I18nProvider>,
    );
    expect(html).toContain("待办");
    expect(html).toContain("进行中");
    expect(html).not.toContain("待处理");
  });

  it("project 模式渲染 project 状态列", () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <Board
          tasks={[]}
          selected={null}
          onSelect={noop}
          boardMode="project"
          accountColumns={[]}
          projectStatuses={projectStatuses}
        />
      </I18nProvider>,
    );
    expect(html).toContain("In Progress");
    expect(html).not.toContain("待处理");
  });

  it("project 模式无状态数据时任务归入未标注列（不出现四态列）", () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <Board
          tasks={[mkTask({ issueKey: "a", status: "todo" })]}
          selected={null}
          onSelect={noop}
          boardMode="project"
          accountColumns={[]}
          projectStatuses={[]}
        />
      </I18nProvider>,
    );
    expect(html).toContain("未标注");
    expect(html).not.toContain("待处理");
  });
});

describe("TaskCard session 行（#197）", () => {
  it("有 session 时分配人下一行展示会话，且底部仍显示时间", () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <TaskCard
          task={mkTask({ issueKey: "a", sessionId: "sess-123", updatedAt: 1725926400 })}
          active={false}
          onSelectKey={noop}
        />
      </I18nProvider>,
    );
    expect(html).toContain("session-row");
    expect(html).toContain("sess-123");
    expect(html).toContain("2024-09-10");
  });

  it("无 session 时不渲染会话行，底部显示时间", () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <TaskCard
          task={mkTask({ issueKey: "a", updatedAt: 1725926400 })}
          active={false}
          onSelectKey={noop}
        />
      </I18nProvider>,
    );
    expect(html).not.toContain("session-row");
    expect(html).toContain("2024-09-10");
  });
});
