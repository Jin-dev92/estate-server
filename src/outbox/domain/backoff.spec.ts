import { computeBackoff } from './backoff';

describe('computeBackoff', () => {
  // 지수 백오프 = base * 2^attempts, 단 cap을 넘지 않는다.
  const BASE = 1000;
  const CAP = 60000;

  it('첫 실패(attempts=0)는 base만큼 기다린다', () => {
    expect(computeBackoff(0, BASE, CAP)).toBe(1000);
  });

  it('attempts가 늘면 2배씩 증가한다', () => {
    expect(computeBackoff(1, BASE, CAP)).toBe(2000);
    expect(computeBackoff(2, BASE, CAP)).toBe(4000);
    expect(computeBackoff(3, BASE, CAP)).toBe(8000);
    expect(computeBackoff(4, BASE, CAP)).toBe(16000);
  });

  it('cap을 넘으면 cap으로 고정된다', () => {
    // 2^6 * 1000 = 64000 > 60000 → cap
    expect(computeBackoff(6, BASE, CAP)).toBe(60000);
    expect(computeBackoff(100, BASE, CAP)).toBe(60000);
  });
});
