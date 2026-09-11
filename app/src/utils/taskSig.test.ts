import { describe, expect, it } from "vitest";
import type { Task } from "../types";
import { taskListSignature } from "./taskSig";

function mkTask(partial: Partial<Task> & { issueKey: string }): Task {
  return {
    owner: "ShawnLiuSZ",
    repo: "task-dashboard",
    number: 1,
    title: "t",
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

describe("taskListSignature (#181)", () => {
  it("相同列表指纹稳定", () => {
    const a = [mkTask({ issueKey: "a#1" }), mkTask({ issueKey: "a#2" })];
    const b = [mkTask({ issueKey: "a#1" }), mkTask({ issueKey: "a#2" })];
    expect(taskListSignature(a)).toBe(taskListSignature(b));
  });

  it("本地写入会碰的字段变化时指纹变化", () => {
    const base = [mkTask({ issueKey: "a#1" })];
    const sig = taskListSignature(base);
    // set_task_status
    expect(taskListSignature([{ ...base[0], status: "doing" }])).not.toBe(sig);
    // touch_session 三件套
    expect(
      taskListSignature([
        { ...base[0], sessionId: "s1", sessionAgent: "opencode", sessionAt: 7 },
      ]),
    ).not.toBe(sig);
    // record_task_handoff
    expect(taskListSignature([{ ...base[0], handoff: "交接" }])).not.toBe(sig);
    // clear_session（有值变无值）
    const withSession = [
      { ...base[0], sessionId: "s1", sessionAgent: "opencode" },
    ];
    expect(taskListSignature(base)).not.toBe(taskListSignature(withSession));
  });

  it("增删任务时指纹变化", () => {
    const one = [mkTask({ issueKey: "a#1" })];
    const two = [...one, mkTask({ issueKey: "a#2", number: 2 })];
    expect(taskListSignature(two)).not.toBe(taskListSignature(one));
    expect(taskListSignature([])).not.toBe(taskListSignature(one));
  });
});
