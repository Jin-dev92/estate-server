import { ConfigService } from '@nestjs/config';
import { KakaoOAuthClient } from './kakao-oauth.client';
import { KakaoResilience } from './kakao-resilience';
import { AppException } from '../../common/errors/app-exception';
import { ConfigKey } from '../../config/config-keys';

const KAKAO_UNAVAILABLE_CODE = 'AUTH_KAKAO_UNAVAILABLE';

// client id/secret + resilience env(overrides로 키별 주입) stub.
function stubConfig(overrides?: Record<string, string>): ConfigService {
  return {
    getOrThrow: (key: ConfigKey) =>
      key === ConfigKey.KakaoClientId ? 'cid' : 'csecret',
    get: (key: string) => overrides?.[key],
  } as unknown as ConfigService;
}

// 정책 상태(브레이커)가 테스트 간 새어 나가지 않도록 매번 새로 조립한다.
function makeClient(overrides?: Record<string, string>): KakaoOAuthClient {
  const config = stubConfig(overrides);
  return new KakaoOAuthClient(config, new KakaoResilience(config));
}

function jsonRes(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const PROFILE_BODY = {
  id: 12345,
  kakao_account: { email: 'a@b.com', profile: { nickname: '홍길동' } },
};

describe('KakaoOAuthClient', () => {
  afterEach(() => jest.restoreAllMocks());

  it('code→token 교환 후 프로필을 매핑한다', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(jsonRes({ access_token: 'AT' }))
      .mockResolvedValueOnce(jsonRes(PROFILE_BODY));

    const profile = await makeClient().exchangeAndFetch(
      'code',
      'http://localhost:3000/cb',
    );

    expect(profile).toEqual({
      providerId: '12345',
      email: 'a@b.com',
      name: '홍길동',
    });
    // 토큰 교환은 POST, 프로필은 Bearer 호출.
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('POST');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('이메일/닉네임 없으면 email=null·name 기본값', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(jsonRes({ access_token: 'AT' }))
      .mockResolvedValueOnce(jsonRes({ id: 9, kakao_account: {} }));

    const profile = await makeClient().exchangeAndFetch('code', 'cb');

    expect(profile).toEqual({
      providerId: '9',
      email: null,
      name: '카카오사용자',
    });
  });

  describe('4xx — 재시도·변환 없이 전파', () => {
    it('토큰 교환 400이면 KakaoApiError 전파, 프로필 호출 안 함', async () => {
      const fetchMock = jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(jsonRes({}, false, 400));

      await expect(makeClient().exchangeAndFetch('bad', 'cb')).rejects.toThrow(
        '카카오 토큰 교환 실패: 400',
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('프로필 401이면 재시도 없이 전파(fetch 총 2회)', async () => {
      const fetchMock = jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(jsonRes({ access_token: 'AT' }))
        .mockResolvedValueOnce(jsonRes({}, false, 401));

      await expect(makeClient().exchangeAndFetch('code', 'cb')).rejects.toThrow(
        '카카오 프로필 조회 실패: 401',
      );

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('재시도 — 프로필 GET만', () => {
    it('프로필 5xx 후 성공하면 재시도로 복구한다', async () => {
      const fetchMock = jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(jsonRes({ access_token: 'AT' }))
        .mockResolvedValueOnce(jsonRes({}, false, 502))
        .mockResolvedValueOnce(jsonRes(PROFILE_BODY));

      const profile = await makeClient().exchangeAndFetch('code', 'cb');

      expect(profile.providerId).toBe('12345');
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('토큰 교환 5xx는 재시도 없이 503으로 변환된다(인가코드 이중 사용 방지)', async () => {
      expect.assertions(3);
      const fetchMock = jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(jsonRes({}, false, 500));

      try {
        await makeClient().exchangeAndFetch('code', 'cb');
      } catch (err) {
        expect(err).toBeInstanceOf(AppException);
        expect((err as AppException).code).toBe(KAKAO_UNAVAILABLE_CODE);
      }

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('네트워크 오류(TypeError) — 503 매핑', () => {
    it('토큰 교환 fetch가 TypeError로 거부되면 재시도 없이 503', async () => {
      expect.assertions(3);
      // fetch가 던지는 네트워크 오류(연결 거부·DNS 등)는 TypeError다.
      const fetchMock = jest
        .spyOn(global, 'fetch')
        .mockRejectedValueOnce(new TypeError('network down'));

      try {
        await makeClient().exchangeAndFetch('code', 'cb');
      } catch (err) {
        expect(err).toBeInstanceOf(AppException);
        expect((err as AppException).code).toBe(KAKAO_UNAVAILABLE_CODE);
      }

      // 토큰 교환은 재시도가 없으므로 fetch는 1회.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('서킷 브레이커', () => {
    it('연속 실패 임계 도달 후 호출은 fetch 없이 즉시 503', async () => {
      expect.assertions(4);
      // 임계 2로 좁혀 빠르게 open. 재시도는 프로필에만 있으므로 토큰 500 사용.
      const overrides = { KAKAO_BREAKER_THRESHOLD: '2' };
      const client = makeClient(overrides);
      const fetchMock = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(jsonRes({}, false, 500));

      await expect(client.exchangeAndFetch('c1', 'cb')).rejects.toThrow();
      await expect(client.exchangeAndFetch('c2', 'cb')).rejects.toThrow();
      // 임계 도달 → open. 3번째는 차단되어 fetch가 늘지 않는다.
      try {
        await client.exchangeAndFetch('c3', 'cb');
      } catch (err) {
        expect((err as AppException).code).toBe(KAKAO_UNAVAILABLE_CODE);
      }

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('벌크헤드·타임아웃', () => {
    it('동시 상한 초과는 즉시 503, 매달린 호출은 시도당 타임아웃으로 503', async () => {
      // 동시 1·큐 0·타임아웃 100ms. 브레이커는 넉넉히 둬 간섭 배제.
      const overrides = {
        KAKAO_BULKHEAD_CONCURRENT: '1',
        KAKAO_BULKHEAD_QUEUE: '0',
        KAKAO_TIMEOUT_MS: '100',
        KAKAO_BREAKER_THRESHOLD: '10',
      };
      const client = makeClient(overrides);
      // 영원히 매달리는 fetch(타임아웃이 끊어야 함).
      jest
        .spyOn(global, 'fetch')
        .mockImplementation(() => new Promise<Response>(() => undefined));

      const hanging = client.exchangeAndFetch('c1', 'cb');
      const rejected = client.exchangeAndFetch('c2', 'cb');

      await expect(rejected).rejects.toMatchObject({
        code: KAKAO_UNAVAILABLE_CODE, // 벌크헤드 포화
      });
      await expect(hanging).rejects.toMatchObject({
        code: KAKAO_UNAVAILABLE_CODE, // 타임아웃
      });
    });
  });
});
