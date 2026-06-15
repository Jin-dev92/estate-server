import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Request, Response } from 'express';
import { ConfigKey } from '../../config/config-keys';
import { TokenPayload } from '../../auth/domain/token-issuer';
import { AppException } from '../errors/app-exception';
import { RateLimitError } from './rate-limit.errors';
import { RATE_LIMIT_STORE, RateLimitStore } from './rate-limit.store';
import {
  DEFAULT_IP_MAX,
  DEFAULT_USER_MAX,
  DEFAULT_WINDOW_SEC,
  RATE_LIMIT_OPTIONS,
  RATE_LIMIT_SKIP,
  RateLimitOptions,
  WRITE_METHODS,
  rateLimitKey,
} from './rate-limit.constants';

// 스팸 요청은 사용량 과금·부하로 이어질 수 있으므로(CLAUDE.md 보안 원칙) 백엔드에서
// userId+IP 이중으로 제한한다. 전역 가드라 쓰기 메서드(또는 @RateLimit 지정)에만 작동.
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly config: ConfigService,
    private readonly jwt: JwtService,
    @Inject(RATE_LIMIT_STORE) private readonly store: RateLimitStore,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];

    // 1. @SkipRateLimit → 통과
    if (this.reflector.getAllAndOverride<boolean>(RATE_LIMIT_SKIP, targets)) {
      return true;
    }

    // 2. @RateLimit(opts) 오버라이드 / 없으면 쓰기 메서드만 기본 적용
    const override = this.reflector.getAllAndOverride<RateLimitOptions>(
      RATE_LIMIT_OPTIONS,
      targets,
    );
    const req = context.switchToHttp().getRequest<Request>();
    const isWrite = WRITE_METHODS.includes(req.method);
    if (!override && !isWrite) return true; // GET 등 읽기 통과

    const windowSec =
      override?.windowSec ??
      this.intConfig(ConfigKey.RateLimitWindowSec, DEFAULT_WINDOW_SEC);
    const userMax =
      override?.userMax ??
      this.intConfig(ConfigKey.RateLimitUserMax, DEFAULT_USER_MAX);
    const ipMax =
      override?.ipMax ??
      this.intConfig(ConfigKey.RateLimitIpMax, DEFAULT_IP_MAX);
    const windowStart = Math.floor(Date.now() / 1000 / windowSec);

    // 3. IP는 항상, userId는 best-effort(토큰 검증 실패해도 거부하지 않음 → IP only)
    const ip = req.ip ?? 'unknown';
    const userId = this.extractUserId(req);

    const checks: Array<{ key: string; max: number }> = [
      { key: rateLimitKey('ip', ip, windowStart), max: ipMax },
    ];
    if (userId) {
      checks.push({
        key: rateLimitKey('user', userId, windowStart),
        max: userMax,
      });
    }

    // Redis 장애로 store.hit이 throw하면 예외가 그대로 전파돼 500이 된다(= fail-closed:
    // 카운트 불가 시 해당 요청을 통과시키지 않음). 가용성보다 보호를 우선한 의도된 동작.
    for (const { key, max } of checks) {
      const count = await this.store.hit(key, windowSec);
      if (count > max) {
        const res = context.switchToHttp().getResponse<Response>();
        const retryAfter =
          windowSec - (Math.floor(Date.now() / 1000) % windowSec);
        res.setHeader('Retry-After', String(retryAfter));
        throw new AppException(RateLimitError.EXCEEDED);
      }
    }
    return true;
  }

  // 토큰을 best-effort로 검증해 sub만 얻는다(실패 시 null → IP only). 실제 인증 거부는 JwtAuthGuard 책임.
  private extractUserId(req: Request): string | null {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) return null;
    try {
      const payload = this.jwt.verify<TokenPayload>(auth.slice(7), {
        secret: this.config.getOrThrow<string>(ConfigKey.JwtSecret),
      });
      return payload.sub;
    } catch {
      return null;
    }
  }

  // env 정수 읽기(미설정/비정상 → 폴백).
  private intConfig(key: ConfigKey, fallback: number): number {
    const v = Number(this.config.get<string>(key));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  }
}
