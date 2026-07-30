import { Inject, Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app-exception';
import { AuthError } from '../auth.errors';
import {
  REFRESH_TOKEN_REPOSITORY,
  RefreshTokenRepository,
} from '../domain/refresh-token.repository';

@Injectable()
export class RevokeSessionUseCase {
  constructor(
    @Inject(REFRESH_TOKEN_REPOSITORY)
    private readonly refreshTokens: RefreshTokenRepository,
  ) {}

  async execute(userId: string, familyId: string): Promise<void> {
    const owner = await this.refreshTokens.findFamilyOwner(familyId);
    // 소유권 검사. 인증만 통과했다고 임의의 familyId를 받으면 타인의 세션을
    // 끊을 수 있다(설계 결정 8 — RBAC + 리소스 소유권 이중 인가).
    // 존재하지 않는 familyId도 같은 에러로 응답한다 — 404로 구분하면
    // 남의 familyId 존재 여부를 알려주는 정보 노출이 된다.
    if (owner !== userId) {
      throw new AppException(AuthError.NOT_SESSION_OWNER);
    }

    await this.refreshTokens.revokeFamily(familyId, new Date());
  }
}
