import { shouldCapture4xx } from './should-capture-4xx';

describe('shouldCapture4xx', () => {
  // 캡처 대상 4xx: 우리 DTO/도메인 계약 위반(FE 버그 신호).
  const VALIDATION = 'VALIDATION_FAILED'; // 422 DomainError
  const COMMON_VALIDATION = 'COMMON_VALIDATION_FAILED'; // 400 검증 실패
  const NOT_FOUND = 'BOARD_POST_NOT_FOUND'; // 사용자발 4xx — 제외

  it('샘플 비율이 0이면 대상 코드라도 캡처하지 않는다', () => {
    expect(shouldCapture4xx(VALIDATION, 0, () => 0)).toBe(false);
  });

  it('대상 코드 + 비율 1이면 캡처한다', () => {
    expect(shouldCapture4xx(VALIDATION, 1, () => 0.99)).toBe(true);
    expect(shouldCapture4xx(COMMON_VALIDATION, 1, () => 0.99)).toBe(true);
  });

  it('대상이 아닌 코드는 비율 1이라도 캡처하지 않는다', () => {
    expect(shouldCapture4xx(NOT_FOUND, 1, () => 0)).toBe(false);
  });

  it('비율에 따라 rng로 샘플링한다(rng < rate일 때만 캡처)', () => {
    expect(shouldCapture4xx(VALIDATION, 0.1, () => 0.05)).toBe(true);
    expect(shouldCapture4xx(VALIDATION, 0.1, () => 0.5)).toBe(false);
  });
});
