import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import ConfirmDialog from "./ConfirmDialog";
import { I18nProvider } from "../i18n";

// 固定中文文案，避免 node 环境下 auto 模式解析不确定。
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

describe("ConfirmDialog（#160）", () => {
  it("渲染提示文案与默认取消/确认按钮", () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <ConfirmDialog message="确定要清空全部同步日志？" onConfirm={noop} onCancel={noop} />
      </I18nProvider>,
    );
    expect(html).toContain("确定要清空全部同步日志？");
    expect(html).toContain("取消");
    expect(html).toContain("确认");
  });

  it("支持自定义按钮文案（删除账号场景）", () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <ConfirmDialog message="删除该账号？" confirmLabel="删除" cancelLabel="取消" onConfirm={noop} onCancel={noop} />
      </I18nProvider>,
    );
    expect(html).toContain("删除该账号？");
    expect(html).toContain("删除");
    expect(html).not.toContain("确认");
  });
});
