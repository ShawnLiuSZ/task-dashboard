import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import NotesPanel, {
  clampNotesWidthPct,
  readNotesWidthPct,
} from "./NotesPanel";
import { I18nProvider } from "../i18n";

// localStorage 桩：notes.widthPct 可控，其余键返回 zh-CN（语言与收起态复用既有模式）。
function stubStorage(width: string | null) {
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => (k === "notes.widthPct" ? width : "zh-CN"),
    setItem: () => {},
    removeItem: () => {},
  });
}

beforeEach(() => {
  stubStorage(null);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("clampNotesWidthPct (#202)", () => {
  it("钳制到 [25, 50]", () => {
    expect(clampNotesWidthPct(10)).toBe(25);
    expect(clampNotesWidthPct(60)).toBe(50);
    expect(clampNotesWidthPct(30)).toBe(30);
  });

  it("非法输入回默认 25", () => {
    expect(clampNotesWidthPct(NaN)).toBe(25);
    expect(clampNotesWidthPct(Infinity)).toBe(25);
  });
});

describe("readNotesWidthPct (#202)", () => {
  it("缺失/空白/非法 → 默认 25", () => {
    stubStorage(null);
    expect(readNotesWidthPct()).toBe(25);
    stubStorage("  ");
    expect(readNotesWidthPct()).toBe(25);
    stubStorage("abc");
    expect(readNotesWidthPct()).toBe(25);
  });

  it("合法值钳制后返回", () => {
    stubStorage("80");
    expect(readNotesWidthPct()).toBe(50);
    stubStorage("30");
    expect(readNotesWidthPct()).toBe(30);
  });
});

describe("NotesPanel 宽度渲染（#202）", () => {
  it("缺省 25% 并带拖拽条", () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <NotesPanel />
      </I18nProvider>,
    );
    expect(html).toContain("25%");
    expect(html).toContain("notes-resizer");
    expect(html).toContain('aria-valuemax="50"');
  });

  it("存档 40% 则按 40% 渲染", () => {
    stubStorage("40");
    const html = renderToStaticMarkup(
      <I18nProvider>
        <NotesPanel />
      </I18nProvider>,
    );
    expect(html).toContain("40%");
    expect(html).not.toContain("25%");
  });
});
