/**
 * #263：设备扫描结果的分组 / 摘要纯逻辑回归测试。
 *
 * 覆盖分组契约的关键分支：卸载优先于已接入、仅残留配置归「疑似已卸载」、
 * 不支持一键接入的 agent 恒入手动组、以及首次扫描不产生变更噪音。
 */

import { describe, expect, it } from 'vitest';
import {
  deviceDetail,
  deviceStateOf,
  GROUP_ORDER,
  groupOf,
  isNewlyInstalled,
  summarize,
  type AgentRowStatus,
} from './agent-groups';
import type { AgentHostInfo, AgentScanResult } from './types';

const host = (agent: string, kind: string, extra: Partial<AgentHostInfo> = {}): AgentHostInfo => ({
  agent,
  present: kind !== 'none',
  kind: kind as AgentHostInfo['kind'],
  binary: null,
  configDir: null,
  app: null,
  ...extra,
});

const scan = (over: Partial<AgentScanResult> = {}): AgentScanResult => ({
  scannedAt: 1_789_000_000,
  previousScannedAt: null,
  hasPrevious: false,
  agents: [],
  newlyInstalled: [],
  newlyRemoved: [],
  ...over,
});

const status = (over: Partial<AgentRowStatus> = {}): AgentRowStatus => ({
  agent: 'claude-code',
  installed: false,
  hostPresent: false,
  ...over,
});

describe('deviceStateOf', () => {
  it('无扫描结果时一律视为未检测到', () => {
    expect(deviceStateOf('claude-code', null)).toBe('none');
  });

  it('快照对比发现可执行/应用包消失 → 疑似已卸载（优先级最高）', () => {
    const s = scan({
      agents: [host('claude-code', 'config-only')],
      newlyRemoved: ['claude-code'],
    });
    expect(deviceStateOf('claude-code', s)).toBe('suspected-removed');
  });

  it('按本次信号强弱返回 cli / app / config-only / none', () => {
    expect(deviceStateOf('a', scan({ agents: [host('a', 'cli')] }))).toBe('cli');
    expect(deviceStateOf('a', scan({ agents: [host('a', 'app')] }))).toBe('app');
    expect(deviceStateOf('a', scan({ agents: [host('a', 'config-only')] }))).toBe('config-only');
    expect(deviceStateOf('a', scan({ agents: [host('a', 'none')] }))).toBe('none');
    // 扫描表里完全没有这个 id → none（不 panic）
    expect(deviceStateOf('ghost', scan({ agents: [] }))).toBe('none');
  });

  it('isNewlyInstalled 只认本轮差异', () => {
    const s = scan({ newlyInstalled: ['codex'] });
    expect(isNewlyInstalled('codex', s)).toBe(true);
    expect(isNewlyInstalled('glm', s)).toBe(false);
    expect(isNewlyInstalled('codex', null)).toBe(false);
  });

  it('deviceDetail 串起命中的路径，缺路径时为空串', () => {
    const s = scan({
      agents: [
        host('codex', 'cli', { binary: '~/.local/bin/codex', configDir: '~/.codex' }),
        host('glm', 'config-only', { configDir: '~/.glm' }),
      ],
    });
    expect(deviceDetail('codex', s)).toBe('~/.local/bin/codex · ~/.codex');
    expect(deviceDetail('glm', s)).toBe('~/.glm');
    expect(deviceDetail('ghost', s)).toBe('');
  });
});

describe('groupOf', () => {
  it('不支持一键接入的 agent 恒入「未接入」（设备状态只做徽标）', () => {
    expect(groupOf({ supported: false, device: 'cli' })).toBe('notIntegrated');
    expect(groupOf({ supported: false, status: status({ installed: true }), device: 'cli' })).toBe(
      'notIntegrated',
    );
    // 手动 agent 即使被判定为「已卸载」也不进该组清理 —— 本面板从未给它装过东西，没有残留可清。
    expect(groupOf({ supported: false, device: 'suspected-removed' })).toBe('notIntegrated');
  });

  it('疑似已卸载优先于已接入 —— 必须先提示清理，而不是报"已接入"', () => {
    expect(
      groupOf({
        supported: true,
        status: status({ installed: true, hostPresent: true }),
        device: 'suspected-removed',
      }),
    ).toBe('uninstalled');
  });

  it('已接入 + 只剩配置目录 → 疑似已卸载（残留接入）', () => {
    expect(
      groupOf({
        supported: true,
        status: status({ installed: true, hostPresent: true }),
        device: 'config-only',
      }),
    ).toBe('uninstalled');
  });

  it('已接入 + 正常信号 → 已接入', () => {
    for (const d of ['cli', 'app'] as const) {
      expect(
        groupOf({
          supported: true,
          status: status({ installed: true, hostPresent: true }),
          device: d,
        }),
      ).toBe('installed');
    }
  });

  it('未接入 + 设备有安装证据 → 可接入（装了没跑过也算）', () => {
    expect(
      groupOf({
        supported: true,
        status: status({ hostPresent: true }),
        device: 'cli',
      }),
    ).toBe('available');
  });

  it('支持一键但本机无任何安装证据 → 与手动配置同组（未接入）', () => {
    expect(groupOf({ supported: true, status: status(), device: 'none' })).toBe('notIntegrated');
  });

  it('未接入 + 仅配置目录 → 疑似已卸载（不是"未安装"）', () => {
    expect(groupOf({ supported: true, status: status(), device: 'config-only' })).toBe(
      'uninstalled',
    );
  });

  it('状态未就绪时不误判为未安装（先给可接入占位）', () => {
    expect(groupOf({ supported: true, device: 'none' })).toBe('available');
  });

  it('共 4 组：旧的「未安装」/「手动配置」已并入「未接入」，不得回归', () => {
    expect(GROUP_ORDER).toEqual(['uninstalled', 'installed', 'available', 'notIntegrated']);
    expect(GROUP_ORDER as string[]).not.toContain('missing');
    expect(GROUP_ORDER as string[]).not.toContain('manual');
  });
});

describe('summarize', () => {
  it('统计已安装 / 新装 / 卸载 / 仅残留配置，并透出上次扫描时间', () => {
    const s = scan({
      previousScannedAt: 1_788_000_000,
      agents: [
        host('claude-code', 'cli'),
        host('opencode', 'cli'),
        host('glm', 'config-only'),
        host('bolt', 'none'),
      ],
      newlyInstalled: ['opencode'],
      newlyRemoved: ['trae'],
    });
    const sum = summarize(s);
    expect(sum.installed).toBe(3);
    expect(sum.newlyInstalled).toEqual(['opencode']);
    expect(sum.newlyRemoved).toEqual(['trae']);
    expect(sum.configOnly).toEqual(['glm']);
    expect(sum.previousScannedAt).toBe(1_788_000_000);
  });

  it('首次扫描（无历史）不产生变更噪音', () => {
    const s = scan({ agents: [host('claude-code', 'cli')] });
    const sum = summarize(s);
    expect(sum.installed).toBe(1);
    expect(sum.newlyInstalled).toEqual([]);
    expect(sum.newlyRemoved).toEqual([]);
    expect(sum.previousScannedAt).toBeNull();
  });
});
