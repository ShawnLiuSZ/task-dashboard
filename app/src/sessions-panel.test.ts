import { describe, expect, it } from 'vitest';
// 仓库约定（见 panel-wiring.test.ts / styles.test.ts）：vitest 跑在 node 环境，
// 不引入 jsdom / testing-library（§2.5 不引入新依赖），组件交互类回归用 `?raw`
// 读源码做静态断言，锁定「接线是否正确」。
import sessionsRaw from './components/SessionsPanel.tsx?raw';
import apiRaw from './api.ts?raw';
import libRaw from '../src-tauri/src/lib.rs?raw';

/**
 * 任务会话多选删除（#391）回归测试。
 *
 * 后端批量逻辑（`clear_task_sessions` 累加 affected、部分不存在不阻断）
 * 由 commands.rs 单元测试覆盖；前端只负责把选中的 issueKey 集合传给
 * `api.clearSessions`。此处静态锁定：API 接线、后端命令注册、组件交互接线。
 */

describe('多选删除后端命令接线（#391）', () => {
  it('api.ts 暴露 clearSessions，调用 clear_sessions 命令并传 keys 数组', () => {
    expect(apiRaw).toMatch(
      /clearSessions:\s*\(keys:\s*string\[\]\)\s*=>\s*invoke<void>\('clear_sessions',\s*\{\s*keys\s*\}\)/,
    );
  });

  it('lib.rs 注册 commands::clear_sessions', () => {
    expect(libRaw).toMatch(/commands::clear_sessions/);
  });
});

describe('SessionsPanel 多选 UI 接线（#391）', () => {
  it('非选择模式渲染「选择」入口（进入选择模式）', () => {
    expect(sessionsRaw).toMatch(/onClick=\{\(\) => setSelectMode\(true\)\}/);
    expect(sessionsRaw).toMatch(/t\('sessions\.select'\)/);
  });

  it('选择模式工具栏含全选/计数/删除选中/取消', () => {
    // 全选按钮文案切换（selectAll / cancelSelectAll）
    expect(sessionsRaw).toMatch(/t\('sessions\.selectAll'\)/);
    expect(sessionsRaw).toMatch(/t\('sessions\.cancelSelectAll'\)/);
    // 已选计数
    expect(sessionsRaw).toMatch(
      /t\('sessions\.selectedCount',\s*\{\s*n:\s*selectedKeys\.size\s*\}\)/,
    );
    // 删除选中按钮
    expect(sessionsRaw).toMatch(/t\('sessions\.deleteSelected'\)/);
    // 退出选择
    expect(sessionsRaw).toMatch(/t\('sessions\.cancelSelect'\)/);
  });

  it('全选逻辑：选中全部 issueKey，再次点击清空', () => {
    const fn =
      sessionsRaw.match(
        /const toggleSelectAll = useCallback\(\(\) => \{[\s\S]*?\n {2}\}, \[sessions\]\);/,
      )?.[0] ?? '';
    expect(fn, '应能取到 toggleSelectAll 函数体').not.toBe('');
    expect(fn).toMatch(
      /prev\.size === sessions\.length \? new Set\(\) : new Set\(sessions\.map\(\(s\) => s\.issueKey\)\)/,
    );
  });

  it('退出选择模式时清空已选集合', () => {
    const fn =
      sessionsRaw.match(
        /const exitSelectMode = useCallback\(\(\) => \{[\s\S]*?\n {2}\}, \[\]\);/,
      )?.[0] ?? '';
    expect(fn, '应能取到 exitSelectMode 函数体').not.toBe('');
    expect(fn).toMatch(/setSelectMode\(false\)/);
    expect(fn).toMatch(/setSelectedKeys\(new Set\(\)\)/);
  });

  it('批量删除：确认后调用 api.clearSessions 并传选中 keys', () => {
    const fn =
      sessionsRaw.match(
        /const handleClearMulti = useCallback\(async \(\) => \{[\s\S]*?\n {2}\}, \[[^\]]*\]\);/,
      )?.[0] ?? '';
    expect(fn, '应能取到 handleClearMulti 函数体').not.toBe('');
    expect(fn).toMatch(/const keys = \[\.\.\.selectedKeys\]/);
    expect(fn).toMatch(/await api\.clearSessions\(keys\)/);
  });

  it('批量删除确认框使用 clearMultiConfirm 并接 handleClearMulti', () => {
    expect(sessionsRaw).toMatch(
      /t\('sessions\.clearMultiConfirm',\s*\{\s*n:\s*selectedKeys\.size\s*\}\)/,
    );
    expect(sessionsRaw).toMatch(/onConfirm=\{\(\) => void handleClearMulti\(\)\}/);
  });

  it('选择模式下隐藏单卡删除按钮（避免与批量删除重复入口）', () => {
    // trash 按钮被 `{!selectMode && (` 包裹
    const block =
      sessionsRaw.match(/\{!selectMode && \([\s\S]*?title=\{t\('sessions\.clear'\)\}/)?.[0] ?? '';
    expect(block, '单卡删除按钮应被 !selectMode 条件包裹').not.toBe('');
  });

  it('选择模式下卡片可点切换选中，并渲染受控复选框', () => {
    // 卡片整卡 onClick 调 toggleSelect（仅 selectMode）
    expect(sessionsRaw).toMatch(
      /onClick=\{\s*selectMode \? \(\) => toggleSelect\(task\.issueKey\) : undefined\s*\}/,
    );
    // selectable / selected class
    expect(sessionsRaw).toMatch(/session-card\$\{selectMode \? ' selectable' : ''\}/);
    expect(sessionsRaw).toMatch(/isSelected \? ' selected' : ''/);
    // 复选框受控
    expect(sessionsRaw).toMatch(/type="checkbox"/);
    expect(sessionsRaw).toMatch(/checked=\{selectedKeys\.has\(task\.issueKey\)\}/);
    expect(sessionsRaw).toMatch(/onChange=\{\(\) => toggleSelect\(task\.issueKey\)\}/);
  });

  it('卡片内功能按钮（打开/复制）阻止事件冒泡，避免误触卡片选中切换', () => {
    // 打开任务按钮 stopPropagation
    expect(sessionsRaw).toMatch(/e\.stopPropagation\(\);\s*handleOpenTask\(task\)/);
  });
});
