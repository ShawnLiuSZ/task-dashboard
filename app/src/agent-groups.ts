/**
 * #263：Agent 接入面板的「设备扫描」结果 → 分组 / 摘要（纯函数，无 React 依赖）。
 *
 * 从 `AgentPanel` 抽出来是为了能单测：分组规则是本功能的核心契约，
 * 而组件层只负责把结果渲染成 DOM（见 `agent-groups.test.ts`）。
 */

import type { AgentHostInfo, AgentScanResult } from './types';

/** 设备安装状态（扫描结果派生 + 差异标记）。 */
export type DeviceState =
  | 'cli' // PATH 上有可执行文件
  | 'app' // 装了 GUI 应用包
  | 'config-only' // 只剩配置目录（疑似已卸载 / 历史残留）
  | 'none' // 未检测到
  | 'suspected-removed'; // 与上次快照对比：可执行/应用包消失了

/**
 * 分组键（与 i18n `settings.hooks.group.*` 一一对应）。
 *
 * 只有 4 组：`notIntegrated` 合并了旧的「未安装 + 手动配置」——
 * 两者在本面板内的**可操作性完全相同**（都没有安装按钮），而「本机装没装」这一
 * 区分已由每行的设备徽标承载，不必再用组名表达。
 */
export type AgentGroupKey = 'installed' | 'available' | 'uninstalled' | 'notIntegrated';

/** 后端 `AgentStatus` 的前端镜像（只取分组用得到的字段）。 */
export interface AgentRowStatus {
  agent: string;
  installed: boolean;
  hostPresent: boolean;
}

export function hostInfoOf(agent: string, scan: AgentScanResult | null): AgentHostInfo | null {
  return scan?.agents.find((a) => a.agent === agent) ?? null;
}

/** 上次扫描没有、这次有了（新装）。 */
export function isNewlyInstalled(agent: string, scan: AgentScanResult | null): boolean {
  return scan?.newlyInstalled.includes(agent) ?? false;
}

/**
 * 设备状态。优先用「与上次快照的差异」判定卸载 —— 这是「已经卸载掉 agent」的
 * 直接证据；其次是本次信号强弱。
 */
export function deviceStateOf(agent: string, scan: AgentScanResult | null): DeviceState {
  if (!scan) return 'none';
  if (scan.newlyRemoved.includes(agent)) return 'suspected-removed';
  const info = hostInfoOf(agent, scan);
  if (!info || !info.present) return 'none';
  return info.kind;
}

/** 设备状态的一段说明（配置目录 / 可执行文件 / 应用包路径），供行内灰字展示。 */
export function deviceDetail(agent: string, scan: AgentScanResult | null): string {
  const info = hostInfoOf(agent, scan);
  if (!info) return '';
  return [info.binary, info.app, info.configDir].filter(Boolean).join(' · ');
}

/**
 * 单行归组（4 组）。
 *
 * - 不支持一键接入的 agent 恒入 `notIntegrated`（设备状态只作徽标展示）。
 * - `suspected-removed`（本轮对比发现可执行/应用包消失）优先归 `uninstalled`。
 * - 已接入但设备上只剩配置目录 → 也归 `uninstalled`，提示残留接入可清理。
 * - 支持一键、但本机确实没有任何安装证据 → `notIntegrated`（与手动配置同组，
 *   行内 detail 会说明「本机未检测到」）。
 */
export function groupOf(opts: {
  supported: boolean;
  status?: AgentRowStatus;
  device: DeviceState;
}): AgentGroupKey {
  const { supported, status, device } = opts;
  if (!supported) return 'notIntegrated';
  if (device === 'suspected-removed') return 'uninstalled';
  if (status?.installed) return device === 'config-only' ? 'uninstalled' : 'installed';
  if (!status) return 'available';
  if (status.hostPresent) return 'available';
  return device === 'config-only' ? 'uninstalled' : 'notIntegrated';
}

export interface ScanSummary {
  /** 扫描到的已安装总数（含不支持一键接入的 agent）。 */
  installed: number;
  /** 本次新发现安装。 */
  newlyInstalled: string[];
  /** 本次疑似已卸载。 */
  newlyRemoved: string[];
  /** 只剩配置目录的 agent。 */
  configOnly: string[];
  /** 上一次扫描时间（秒）；首次为 null。 */
  previousScannedAt: number | null;
}

export function summarize(scan: AgentScanResult): ScanSummary {
  return {
    installed: scan.agents.filter((a) => a.present).length,
    newlyInstalled: scan.newlyInstalled,
    newlyRemoved: scan.newlyRemoved,
    configOnly: scan.agents.filter((a) => a.kind === 'config-only').map((a) => a.agent),
    previousScannedAt: scan.previousScannedAt ?? null,
  };
}

/** 分组展示顺序（与折叠区渲染顺序一致：先要处理的，再可操作的，最后未接入的）。 */
export const GROUP_ORDER: AgentGroupKey[] = [
  'uninstalled',
  'installed',
  'available',
  'notIntegrated',
];
