export const KAKAO_OAUTH = Symbol('KAKAO_OAUTH');

export interface KakaoProfile {
  providerId: string;
  email: string | null;
  name: string;
}

export interface KakaoOAuth {
  // 인가 code를 access token으로 교환하고 프로필을 조회한다.
  exchangeAndFetch(code: string, redirectUri: string): Promise<KakaoProfile>;
}
