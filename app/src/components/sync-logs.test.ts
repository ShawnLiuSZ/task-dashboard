import { describe, expect, it } from "vitest";
import { accountLabelForLog, syncLogErrorText, toggleExpanded } from "./SyncLogsPanel";

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

describe("accountLabelForLog (#224)", () => {
  it("命中账号显示 @login", () => {
    expect(
      accountLabelForLog(
        [
          { id: 1, login: "alice" },
          { id: 2, login: "bob" },
        ],
        2,
      ),
    ).toBe("@bob");
  });

  it("账号已删回退 #id", () => {
    expect(accountLabelForLog([{ id: 1, login: "alice" }], 9)).toBe("#9");
    expect(accountLabelForLog([], 9)).toBe("#9");
  });
});
