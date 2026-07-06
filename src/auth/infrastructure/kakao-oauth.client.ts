import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BrokenCircuitError,
  BulkheadRejectedError,
  IPolicy,
  TaskCancelledError,
} from 'cockatiel';
import { ConfigKey } from '../../config/config-keys';
import { KakaoOAuth, KakaoProfile } from '../domain/kakao-oauth';
import { AppException } from '../../common/errors/app-exception';
import { AuthError } from '../auth.errors';
import { KakaoApiError } from './kakao-api.error';
import { KakaoResilience } from './kakao-resilience';

const TOKEN_URL = 'https://kauth.kakao.com/oauth/token';
const PROFILE_URL = 'https://kapi.kakao.com/v2/user/me';
const TOKEN_LABEL = '토큰 교환';
const PROFILE_LABEL = '프로필 조회';

@Injectable()
export class KakaoOAuthClient implements KakaoOAuth {
  private readonly logger = new Logger(KakaoOAuthClient.name);

  constructor(
    private readonly config: ConfigService,
    private readonly resilience: KakaoResilience,
  ) {}

  async exchangeAndFetch(
    code: string,
    redirectUri: string,
  ): Promise<KakaoProfile> {
    const clientId = this.config.getOrThrow<string>(ConfigKey.KakaoClientId);
    const clientSecret = this.config.getOrThrow<string>(
      ConfigKey.KakaoClientSecret,
    );

    // 토큰 교환(POST·비멱등): 재시도 없는 tokenPolicy.
    const token = (await this.callKakao(
      this.resilience.tokenPolicy,
      TOKEN_LABEL,
      (signal) =>
        fetch(TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri,
            code,
          }),
          signal,
        }),
    )) as { access_token: string };

    // 프로필 조회(GET·멱등): 재시도 포함 profilePolicy.
    const p = (await this.callKakao(
      this.resilience.profilePolicy,
      PROFILE_LABEL,
      (signal) =>
        fetch(PROFILE_URL, {
          headers: { Authorization: `Bearer ${token.access_token}` },
          signal,
        }),
    )) as {
      id: number;
      kakao_account?: { email?: string; profile?: { nickname?: string } };
    };

    return {
      providerId: String(p.id),
      email: p.kakao_account?.email ?? null,
      name: p.kakao_account?.profile?.nickname ?? '카카오사용자',
    };
  }

  // 정책으로 감싼 카카오 호출. non-ok 판정을 정책 "안"에서 던져야
  // 재시도·브레이커가 5xx를 실패로 집계한다. AbortSignal은 타임아웃 정책이 공급.
  private async callKakao(
    policy: IPolicy,
    label: string,
    request: (signal: AbortSignal) => Promise<Response>,
  ): Promise<unknown> {
    try {
      return await policy.execute(async ({ signal }) => {
        const res = await request(signal);
        if (!res.ok) throw new KakaoApiError(label, res.status);
        return res.json() as Promise<unknown>;
      });
    } catch (err) {
      throw this.mapFailure(err, label);
    }
  }

  // 실패 매핑(스펙 §6): 4xx는 그대로(사용자·계약 오류), 거절·일시 오류는
  // 원인별 로깅 후 공통 503으로. 내부 에러 문자열은 사용자에게 노출하지 않는다.
  private mapFailure(err: unknown, label: string): unknown {
    if (err instanceof KakaoApiError && !err.transient) return err;
    if (err instanceof BrokenCircuitError) {
      this.logger.warn(`카카오 ${label} 거부 — circuit open(빠른 실패)`);
      return new AppException(AuthError.KAKAO_UNAVAILABLE);
    }
    if (err instanceof BulkheadRejectedError) {
      this.logger.warn(`카카오 ${label} 거부 — 벌크헤드 포화`);
      return new AppException(AuthError.KAKAO_UNAVAILABLE);
    }
    if (err instanceof TaskCancelledError) {
      this.logger.warn(`카카오 ${label} 실패 — 시도당 타임아웃 초과`);
      return new AppException(AuthError.KAKAO_UNAVAILABLE);
    }
    if (err instanceof KakaoApiError || err instanceof TypeError) {
      this.logger.warn(`카카오 ${label} 실패 — 일시 오류(5xx·네트워크) 소진`);
      return new AppException(AuthError.KAKAO_UNAVAILABLE);
    }
    return err;
  }
}
