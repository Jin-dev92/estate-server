import { ConfigService } from '@nestjs/config';
import { KakaoResilience, parseEnvNumber } from './kakao-resilience';
import { KakaoApiError } from './kakao-api.error';

const FALLBACK = 3000;

// env 미설정(기본값) ConfigService stub. overrides로 특정 키만 주입.
function stubConfig(overrides?: Record<string, string>): ConfigService {
  return {
    get: (key: string) => overrides?.[key],
  } as unknown as ConfigService;
}

describe('KakaoResilience', () => {
  it('tokenPolicy·profilePolicy를 노출하고 성공 결과를 그대로 반환한다', async () => {
    const r = new KakaoResilience(stubConfig());

    const result = await r.tokenPolicy.execute(() => Promise.resolve('ok'));

    expect(result).toBe('ok');
  });

  it('profilePolicy는 일시 오류(5xx) 후 성공하면 재시도로 복구한다', async () => {
    const r = new KakaoResilience(stubConfig());
    let calls = 0;

    const result = await r.profilePolicy.execute(() => {
      calls += 1;
      if (calls === 1)
        return Promise.reject(new KakaoApiError('프로필 조회', 500));
      return Promise.resolve('recovered');
    });

    expect(result).toBe('recovered');
    expect(calls).toBe(2);
  });

  it('profilePolicy도 4xx는 재시도하지 않는다', async () => {
    const r = new KakaoResilience(stubConfig());
    let calls = 0;

    await expect(
      r.profilePolicy.execute(() => {
        calls += 1;
        return Promise.reject(new KakaoApiError('프로필 조회', 401));
      }),
    ).rejects.toThrow('카카오 프로필 조회 실패: 401');

    expect(calls).toBe(1);
  });

  it('tokenPolicy는 일시 오류(5xx)라도 재시도하지 않는다', async () => {
    const r = new KakaoResilience(stubConfig());
    let calls = 0;

    await expect(
      r.tokenPolicy.execute(() => {
        calls += 1;
        return Promise.reject(new KakaoApiError('토큰 교환', 500));
      }),
    ).rejects.toThrow('카카오 토큰 교환 실패: 500');

    expect(calls).toBe(1);
  });
});

describe('parseEnvNumber', () => {
  describe('유효한 숫자 문자열', () => {
    it('숫자로 변환한다', () => {
      expect(parseEnvNumber('5000', FALLBACK)).toBe(5000);
    });

    it('"0"은 정상값으로 보존한다(예: 벌크헤드 큐 0)', () => {
      expect(parseEnvNumber('0', FALLBACK)).toBe(0);
    });
  });

  describe('폴백 대상', () => {
    it('미설정(undefined)은 fallback', () => {
      expect(parseEnvNumber(undefined, FALLBACK)).toBe(FALLBACK);
    });

    it('빈 문자열은 fallback(Number("")=0 함정 방지)', () => {
      expect(parseEnvNumber('', FALLBACK)).toBe(FALLBACK);
    });

    it('공백 문자열은 fallback', () => {
      expect(parseEnvNumber('   ', FALLBACK)).toBe(FALLBACK);
    });

    it('비숫자 문자열("abc")은 fallback(NaN 전달 방지)', () => {
      expect(parseEnvNumber('abc', FALLBACK)).toBe(FALLBACK);
    });
  });
});
