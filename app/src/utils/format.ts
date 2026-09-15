/**
 * 把秒数格式化为「分:秒」（如 2:34）。
 *
 * - 向下取整，丢弃毫秒/小数部分
 * - 秒数固定两位，分钟不补零
 * - 负数或 0 统一显示为 0:00
 *
 * 例：
 *   formatCountdownSeconds(154)   -> "2:34"
 *   formatCountdownSeconds(900)   -> "15:00"
 *   formatCountdownSeconds(59.7)  -> "0:59"
 *   formatCountdownSeconds(-5)    -> "0:00"
 */
export function formatCountdownSeconds(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds || 0));
  const minutes = Math.floor(s / 60);
  const seconds = s % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
