export const REFRESH_TOKEN_GENERATOR = Symbol('REFRESH_TOKEN_GENERATOR');

// 랜덤 생성과 해시를 포트 뒤로 감춘다. 목적은 두 가지다.
// 1) 도메인·application이 node:crypto를 모르게 한다(의존성 역전)
// 2) 유스케이스 테스트에서 결정적 값을 반환하는 가짜로 갈아끼울 수 있다
//    — 난수를 직접 호출하면 "어떤 토큰이 발급됐는가"를 단정할 수 없다
export interface RefreshTokenGenerator {
  // 원문과 해시를 함께 반환한다. 원문은 클라이언트에게만 주고 저장하지 않는다.
  generate(): { token: string; tokenHash: string };
  // 들어온 토큰을 조회용으로 해시한다.
  hash(token: string): string;
}
