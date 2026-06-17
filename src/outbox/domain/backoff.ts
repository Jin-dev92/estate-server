// 지수 백오프 계산(순수 함수). 재시도 간격 = base * 2^attempts, 단 cap을 상한으로.
// attempts는 "지금까지 실패한 횟수"(0-base) → 첫 실패(0)는 base, 그다음 2배씩.
// 순수 함수라 단위 테스트가 쉽고, store가 이 값을 nextAttemptAt 계산에 쓴다.
export function computeBackoff(
  attempts: number,
  baseMs: number,
  capMs: number,
): number {
  const delay = baseMs * 2 ** attempts;
  return Math.min(delay, capMs);
}
