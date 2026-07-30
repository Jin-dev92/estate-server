import { Inject, Injectable } from '@nestjs/common';
import {
  REFRESH_TOKEN_GENERATOR,
  RefreshTokenGenerator,
} from '../domain/refresh-token-generator';
import {
  REFRESH_TOKEN_REPOSITORY,
  RefreshTokenRepository,
} from '../domain/refresh-token.repository';

@Injectable()
export class LogoutUseCase {
  constructor(
    @Inject(REFRESH_TOKEN_REPOSITORY)
    private readonly refreshTokens: RefreshTokenRepository,
    @Inject(REFRESH_TOKEN_GENERATOR)
    private readonly generator: RefreshTokenGenerator,
  ) {}

  async execute(refreshToken: string): Promise<void> {
    const found = await this.refreshTokens.findByHash(
      this.generator.hash(refreshToken),
    );
    // 알 수 없는 토큰이어도 에러를 내지 않는다. 로그아웃은 멱등해야 하고,
    // 클라이언트가 이미 세션을 버린 뒤 재시도하는 경우가 정상적으로 있다.
    if (!found) return;

    await this.refreshTokens.revokeFamily(found.familyId, new Date());
  }
}
