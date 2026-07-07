// 카카오 HTTP non-ok 응답용 예외. status를 보존해 일시성(재시도 가능) 판별에 쓴다.
// 문자열 Error로는 4xx/5xx를 구분할 수 없어 handleAll 재시도가 강제되는 문제를 푼다.
export class KakaoApiError extends Error {
  constructor(
    label: string,
    readonly status: number,
  ) {
    super(`카카오 ${label} 실패: ${status}`);
    this.name = 'KakaoApiError';
  }

  // 일시적(카카오 측) 오류 — 429·5xx만. 4xx는 사용자·계약 오류라 재시도 금지(위키 팀룰).
  get transient(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}
