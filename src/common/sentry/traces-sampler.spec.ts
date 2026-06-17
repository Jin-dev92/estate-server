import { decideTraceSample } from './traces-sampler';

describe('decideTraceSample', () => {
  const RATE = 0.1;

  it('비즈니스 외 경로(/docs·/docs-json)는 추적하지 않는다(0)', () => {
    expect(decideTraceSample('GET /docs', RATE)).toBe(0);
    expect(decideTraceSample('GET /docs-json', RATE)).toBe(0);
  });

  it('비즈니스 경로는 기본 샘플링 비율을 쓴다', () => {
    expect(decideTraceSample('GET /buildings/abc/posts', RATE)).toBe(0.1);
    expect(decideTraceSample('POST /auth/login', RATE)).toBe(0.1);
  });

  it('이름이 없으면 기본 비율로 폴백한다', () => {
    expect(decideTraceSample(undefined, RATE)).toBe(0.1);
  });
});
