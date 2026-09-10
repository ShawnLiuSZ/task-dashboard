import { describe, expect, it } from "vitest";
import { extractUnmappedStatuses } from "./Board";
import type { Task } from "../types";

function mkTask(projectStatus: string): Task {
  return {
    issueKey: `test-${projectStatus}-${Math.random()}`,
    owner: "ShawnLiuSZ",
    repo: "task-dashboard",
    number: 1,
    title: "",
    url: "",
    issueState: "open",
    ownership: "notassignee",
    status: "todo",
    projectStatus,
    assignees: "",
    mentioned: false,
    latestCommentUrl: "",
    prNumber: 0,
    prUrl: "",
    branch: "",
    sessionId: null,
    sessionAgent: null,
    sessionAt: null,
    candidateDone: false,
    handoff: "",
    updatedAt: null,
    accountId: 1,
  };
}

describe("extractUnmappedStatuses (#165)", () => {
  it("去重并统计未映射状态值（按首次出现顺序）", () => {
    const tasks = [
      mkTask("🧠需求池"),
      mkTask("🚧 待开发处理"),
      mkTask("🧠需求池"),
      mkTask("Done"),
    ];
    expect(extractUnmappedStatuses(tasks)).toEqual([
      { value: "🧠需求池", count: 2 },
      { value: "🚧 待开发处理", count: 1 },
      { value: "Done", count: 1 },
    ]);
  });

  it("剔除空值（空字符串 / 纯空格）", () => {
    const tasks = [mkTask(""), mkTask("   "), mkTask("Ready")];
    expect(extractUnmappedStatuses(tasks)).toEqual([{ value: "Ready", count: 1 }]);
  });

  it("全部为空时返回空数组", () => {
    expect(extractUnmappedStatuses([mkTask(""), mkTask("")])).toEqual([]);
  });

  it("空任务数组返回空数组", () => {
    expect(extractUnmappedStatuses([])).toEqual([]);
  });
});
