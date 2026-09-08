import { describe, expect, it } from "vitest";
import { syncLogErrorText, toggleExpanded } from "./SyncLogsPanel";

describe("syncLogErrorText (#161)", () => {
  it("优先展示 errorMessage", () => {
    expect(
      syncLogErrorText({ errorMessage: "GraphQL 查询失败", failedSources: "repo-a; repo-b" }),
    ).toBe("GraphQL 查询失败");
  });

  it("无 errorMessage 时回退 failedSources", () => {
    expect(syncLogErrorText({ errorMessage: "", failedSources: "repo-a; repo-b" })).toBe(
      "repo-a; repo-b",
    );
  });

  it("两者皆空返回 null（渲染 '-'）", () => {
    expect(syncLogErrorText({ errorMessage: "", failedSources: "" })).toBeNull();
  });
});

describe("toggleExpanded (#161)", () => {
  it("点击未展开行展开该行", () => {
    expect(toggleExpanded(null, 1)).toBe(1);
    expect(toggleExpanded(2, 1)).toBe(1);
  });

  it("再次点击已展开行收起", () => {
    expect(toggleExpanded(1, 1)).toBeNull();
  });
});
