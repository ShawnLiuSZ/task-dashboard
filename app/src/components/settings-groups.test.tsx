import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import SettingsPanel from './SettingsPanel';
import AgentPanel from './AgentPanel';
import { I18nProvider } from '../i18n';
import type { Settings } from '../types';

beforeEach(() => {
  vi.stubGlobal('localStorage', {
    getItem: () => 'zh-CN',
    setItem: () => {},
    removeItem: () => {},
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const noop = () => {};

function mkSettings(): Settings {
  return {
    scheduleMinutes: 60,
    ghPath: '',
    login: '',
    org: '',
    lastSyncAt: 0,
    dbPath: '',
    hasPat: false,
    lastSyncError: '',
    activeAccountId: 0,
    viewMode: 'single',
    accounts: [],
    oauthClientId: '',
    autoCheckUpdates: false,
    autoUpdate: false,
  };
}

describe('Agent 分组下拉（#207，已随接入页迁至 AgentPanel）', () => {
  it('未查询时可接入/手动两组标题为可点开关且默认展开', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <AgentPanel onClose={noop} />
      </I18nProvider>,
    );
    // SSR 不跑 effect，hooksStatus 为 null：支持的一键 agent 进可接入，不支持的进手动配置
    expect(html).toContain('hook-group-toggle');
    expect(html).toContain('aria-expanded="true"');
    // 行默认可见（未收起）
    expect(html).toContain('Claude Code');
  });

  it('存档收起态下对应组收起、行不可见', () => {
    vi.stubGlobal('localStorage', {
      getItem: (k: string) =>
        k === 'agents.hooks.groupsCollapsed' ? '{"notIntegrated":true}' : 'zh-CN',
      setItem: () => {},
      removeItem: () => {},
    });
    const html = renderToStaticMarkup(
      <I18nProvider>
        <AgentPanel onClose={noop} />
      </I18nProvider>,
    );
    expect(html).toContain('aria-expanded="false"');
    // 「未接入」组收起：其行内提示（如 codex 路径）不可见，可接入组仍展开
    expect(html).toContain('aria-expanded="true"');
  });
});

describe('自定义列映射页签（#226）', () => {
  it('暂关闭：无入口', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <SettingsPanel settings={mkSettings()} onSaved={noop} onClose={noop} />
      </I18nProvider>,
    );
    expect(html).not.toContain('自定义列映射');
  });
});

describe('设备扫描入口（#263）', () => {
  it('未扫描时不渲染设备徽标与摘要，刷新按钮文案为「扫描设备」', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <AgentPanel onClose={noop} />
      </I18nProvider>,
    );
    // 按钮已从「刷新状态」升级为设备扫描
    expect(html).toContain('扫描设备');
    // 无扫描结果：不出现设备徽标（避免全屏「未检测到」噪音），也不出摘要
    expect(html).not.toContain('agent-device');
    expect(html).not.toContain('扫描于');
  });
});
