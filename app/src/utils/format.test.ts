import { describe, expect, it } from 'vitest';
import { formatCountdownSeconds } from './format';

describe('formatCountdownSeconds', () => {
  it('formats minutes and seconds as M:SS', () => {
    expect(formatCountdownSeconds(154)).toBe('2:34');
    expect(formatCountdownSeconds(59)).toBe('0:59');
    expect(formatCountdownSeconds(900)).toBe('15:00');
  });

  it('floors fractional seconds (drops milliseconds)', () => {
    expect(formatCountdownSeconds(154.567)).toBe('2:34');
    expect(formatCountdownSeconds(59.999)).toBe('0:59');
  });

  it('handles zero and negative values', () => {
    expect(formatCountdownSeconds(0)).toBe('0:00');
    expect(formatCountdownSeconds(-5)).toBe('0:00');
  });
});
