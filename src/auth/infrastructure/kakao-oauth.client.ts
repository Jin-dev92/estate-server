import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConfigKey } from '../../config/config-keys';
import { KakaoOAuth, KakaoProfile } from '../domain/kakao-oauth';

const TOKEN_URL = 'https://kauth.kakao.com/oauth/token';
const PROFILE_URL = 'https://kapi.kakao.com/v2/user/me';

@Injectable()
export class KakaoOAuthClient implements KakaoOAuth {
  constructor(private readonly config: ConfigService) {}

  async exchangeAndFetch(
    code: string,
    redirectUri: string,
  ): Promise<KakaoProfile> {
    const clientId = this.config.getOrThrow<string>(ConfigKey.KakaoClientId);
    const clientSecret = this.config.getOrThrow<string>(
      ConfigKey.KakaoClientSecret,
    );

    const tokenRes = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        code,
      }),
    });
    if (!tokenRes.ok)
      throw new Error(`카카오 토큰 교환 실패: ${tokenRes.status}`);
    const token = (await tokenRes.json()) as { access_token: string };

    const profRes = await fetch(PROFILE_URL, {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    if (!profRes.ok)
      throw new Error(`카카오 프로필 조회 실패: ${profRes.status}`);
    const p = (await profRes.json()) as {
      id: number;
      kakao_account?: { email?: string; profile?: { nickname?: string } };
    };

    return {
      providerId: String(p.id),
      email: p.kakao_account?.email ?? null,
      name: p.kakao_account?.profile?.nickname ?? '카카오사용자',
    };
  }
}
