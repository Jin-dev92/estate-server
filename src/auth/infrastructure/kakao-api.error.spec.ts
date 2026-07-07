import { KakaoApiError } from './kakao-api.error';

describe('KakaoApiError', () => {
  it('메시지에 라벨과 status를 담는다', () => {
    const err = new KakaoApiError('토큰 교환', 400);

    expect(err.message).toBe('카카오 토큰 교환 실패: 400');
    expect(err.status).toBe(400);
  });

  describe('transient (일시성 판별)', () => {
    it.each([429, 500, 502, 503, 504])('%i은 일시적(재시도 대상)', (status) => {
      expect(new KakaoApiError('프로필 조회', status).transient).toBe(true);
    });

    it.each([400, 401, 403, 404])(
      '%i는 일시적이 아님(재시도 금지)',
      (status) => {
        expect(new KakaoApiError('프로필 조회', status).transient).toBe(false);
      },
    );
  });
});
