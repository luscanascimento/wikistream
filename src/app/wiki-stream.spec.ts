import { RECORDED } from './fixtures/recorded';
import { backoffDelay, isRecentChange } from './wiki-stream';

describe('backoffDelay', () => {
  it('grows exponentially and caps at 30s', () => {
    const max = (attempt: number) => backoffDelay(attempt, () => 1);
    expect(max(1)).toBe(1_000);
    expect(max(2)).toBe(2_000);
    expect(max(3)).toBe(4_000);
    expect(max(10)).toBe(30_000);
    expect(max(50)).toBe(30_000);
  });

  it('jitters down to zero so clients do not reconnect in lockstep', () => {
    expect(backoffDelay(5, () => 0)).toBe(0);
    expect(backoffDelay(5, () => 0.5)).toBe(8_000);
  });
});

describe('isRecentChange', () => {
  it('accepts every payload in the recorded fixture', () => {
    expect(RECORDED).toHaveLength(300);
    expect(RECORDED.every(isRecentChange)).toBe(true);
  });

  it('rejects anything that is not a change, without throwing', () => {
    const good = RECORDED[0];
    expect(isRecentChange(null)).toBe(false);
    expect(isRecentChange(undefined)).toBe(false);
    expect(isRecentChange('edit')).toBe(false);
    expect(isRecentChange(42)).toBe(false);
    expect(isRecentChange([good])).toBe(false);
    expect(isRecentChange({ ...good, title: undefined })).toBe(false);
    expect(isRecentChange({ ...good, server_name: 12 })).toBe(false);
  });
});
