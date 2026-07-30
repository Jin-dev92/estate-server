import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { ConfigKey } from '../../config/config-keys';
import { TransactionClient } from '../../outbox/domain/transaction-runner';
import { Role } from '../domain/role.enum';
import { RefreshToken } from '../domain/refresh-token.entity';
import {
  REFRESH_TOKEN_GENERATOR,
  RefreshTokenGenerator,
} from '../domain/refresh-token-generator';
import {
  REFRESH_TOKEN_REPOSITORY,
  RefreshTokenRepository,
} from '../domain/refresh-token.repository';
import { TOKEN_ISSUER, TokenIssuer } from '../domain/token-issuer';

const DEFAULT_TTL_DAYS = 14;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

// 로그인 3곳(login·kakao-login·complete-kakao-signup)과 갱신이 공유하는
// 세션 발급 절차. 한 곳에 모으는 이유는 발급 순서 제약 때문이다 —
// 액세스 토큰이 fam 클레임을 담아야 하므로 리프레시 토큰을 먼저 발급해
// familyId를 확정한 뒤 액세스 토큰을 만들어야 한다.
@Injectable()
export class IssueSessionService {
  constructor(
    @Inject(TOKEN_ISSUER) private readonly tokenIssuer: TokenIssuer,
    @Inject(REFRESH_TOKEN_GENERATOR)
    private readonly generator: RefreshTokenGenerator,
    @Inject(REFRESH_TOKEN_REPOSITORY)
    private readonly refreshTokens: RefreshTokenRepository,
    private readonly config: ConfigService,
  ) {}

  private ttlDays(): number {
    const raw = this.config.get<string>(
      ConfigKey.RefreshTokenTtlDays,
      String(DEFAULT_TTL_DAYS),
    );
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_DAYS;
  }

  // familyId 를 주지 않으면 새 가족을 만든다(로그인).
  // 주면 그 값을 유지한다(회전) — 같은 세션으로 이어진다.
  async issue(
    input: { userId: string; email: string; role: Role },
    familyId?: string,
    tx?: TransactionClient,
  ): Promise<TokenPair> {
    const { token, tokenHash } = this.generator.generate();
    const expiresAt = new Date(Date.now() + this.ttlDays() * MS_PER_DAY);

    const saved = await this.refreshTokens.save(
      RefreshToken.create({
        userId: input.userId,
        tokenHash,
        familyId: familyId ?? randomUUID(),
        expiresAt,
      }),
      tx,
    );

    const accessToken = await this.tokenIssuer.issue({
      sub: input.userId,
      email: input.email,
      role: input.role,
      fam: saved.familyId,
    });

    return { accessToken, refreshToken: token };
  }
}
