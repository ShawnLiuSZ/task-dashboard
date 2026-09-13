import { describe, expect, it } from "vitest";
import {
  accountLabelForLog,
  apiLogHasDetail,
  apiLogKindLabel,
  apiLogParamText,
  filterApiLogs,
  syncLogErrorText,
  toggleExpanded,
} from "./SyncLogsPanel";
import type { ApiLog } from "../types";
import zhCN from "../i18n/locales/zh-CN.json";
import enUS from "../i18n/locales/en-US.json";

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

// ── #235：API 调用明细（请求 / 返回参数） ────────────────────────────────

/** 构造一条 API 明细，默认成功、无参数。 */
function mkApiLog(over: Partial<ApiLog> = {}): ApiLog {
  return {
    id: 1,
    kind: "sync",
    accountId: 0,
    syncLogId: 0,
    method: "GET",
    target: "/repos/a/b",
    status: 200,
    ok: true,
    elapsedMs: 12,
    request: "",
    response: "",
    createdAt: 1_700_000_000,
    ...over,
  };
}

describe("apiLogKindLabel (#235)", () => {
  const t = (key: string) => `T:${key}`;

  it("已知类型映射到对应 i18n key", () => {
    expect(apiLogKindLabel(t, "sync")).toBe("T:syncLogs.api.kind.sync");
    expect(apiLogKindLabel(t, "claim")).toBe("T:syncLogs.api.kind.claim");
    expect(apiLogKindLabel(t, "status")).toBe("T:syncLogs.api.kind.status");
  });

  it("未知类型原样返回，不吞掉信息", () => {
    expect(apiLogKindLabel(t, "weird")).toBe("weird");
  });
});

describe("filterApiLogs (#235)", () => {
  const logs = [
    mkApiLog({ id: 1, kind: "sync" }),
    mkApiLog({ id: 2, kind: "claim" }),
    mkApiLog({ id: 3, kind: "sync" }),
  ];

  it("all / 空值不过滤", () => {
    expect(filterApiLogs(logs, "all")).toHaveLength(3);
    expect(filterApiLogs(logs, "")).toHaveLength(3);
  });

  it("按类型过滤只留匹配项", () => {
    expect(filterApiLogs(logs, "sync").map((l) => l.id)).toEqual([1, 3]);
    expect(filterApiLogs(logs, "claim").map((l) => l.id)).toEqual([2]);
    expect(filterApiLogs(logs, "status")).toEqual([]);
  });
});

describe("apiLogParamText / apiLogHasDetail (#235)", () => {
  it("空白（含空格换行）视为无参数", () => {
    expect(apiLogParamText("")).toBeNull();
    expect(apiLogParamText("   \n ")).toBeNull();
  });

  it("有内容时返回去掉首尾空白的原文", () => {
    expect(apiLogParamText("  {\"a\":1}  ")).toBe('{"a":1}');
  });

  it("请求或返回任一非空即可展开", () => {
    expect(apiLogHasDetail({ request: "", response: "" })).toBe(false);
    expect(apiLogHasDetail({ request: "q=1", response: "" })).toBe(true);
    expect(apiLogHasDetail({ request: "", response: "{}" })).toBe(true);
  });
});

/** #235：面板新增的 i18n key 必须双语齐备（check-i18n 只比 key 数量，兜不住漏翻）。 */
describe("syncLogs API 明细 i18n key 齐备 (#235)", () => {
  const KEYS = [
    "syncLogs.tabs.sync",
    "syncLogs.tabs.api",
    "syncLogs.api.kind.sync",
    "syncLogs.api.kind.claim",
    "syncLogs.api.kind.status",
    "syncLogs.api.empty",
    "syncLogs.api.filter.all",
    "syncLogs.api.headers.kind",
    "syncLogs.api.headers.method",
    "syncLogs.api.headers.target",
    "syncLogs.api.headers.status",
    "syncLogs.api.headers.elapsed",
    "syncLogs.api.headers.detail",
    "syncLogs.api.detailHint",
    "syncLogs.api.view",
    "syncLogs.api.requestLabel",
    "syncLogs.api.responseLabel",
    "syncLogs.api.none",
  ];

  it.each(KEYS)("%s 在中英两份 locale 都存在", (key) => {
    expect((zhCN as Record<string, string>)[key]).toBeTruthy();
    expect((enUS as Record<string, string>)[key]).toBeTruthy();
  });
});
