import {ConfigService} from '@nestjs/config';
import {KakaoOAuthClient} from './kakao-oauth.client';
import {ConfigKey} from '../../config/config-keys';

// ConfigService stub — client id/secret만 제공.
const config = {
  getOrThrow: (key: ConfigKey) =>
    key === ConfigKey.KakaoClientId ? 'cid' : 'csecret',
} as unknown as ConfigService;

function jsonRes(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe('KakaoOAuthClient', () => {
  afterEach(() => jest.restoreAllMocks());

  it('code→token 교환 후 프로필을 매핑한다', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(jsonRes({ access_token: 'AT' }))
      .mockResolvedValueOnce(
        jsonRes({
          id: 12345,
          kakao_account: { email: 'a@b.com', profile: { nickname: '홍길동' } },
        }),
      );

    const client = new KakaoOAuthClient(config);
    const profile = await client.exchangeAndFetch(
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

    const client = new KakaoOAuthClient(config);
    const profile = await client.exchangeAndFetch('code', 'cb');

    expect(profile).toEqual({
      providerId: '9',
      email: null,
      name: '카카오사용자',
    });
  });

  it('토큰 교환 실패면 throw (프로필 호출 안 함)', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(jsonRes({}, false, 400));

    const client = new KakaoOAuthClient(config);
    await expect(client.exchangeAndFetch('bad', 'cb')).rejects.toThrow(
      '카카오 토큰 교환 실패',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('프로필 조회 실패면 throw', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(jsonRes({ access_token: 'AT' }))
      .mockResolvedValueOnce(jsonRes({}, false, 401));

    const client = new KakaoOAuthClient(config);
    await expect(client.exchangeAndFetch('code', 'cb')).rejects.toThrow(
      '카카오 프로필 조회 실패',
    );
  });
});
