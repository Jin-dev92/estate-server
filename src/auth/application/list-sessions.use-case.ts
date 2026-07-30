import { Inject, Injectable } from '@nestjs/common';
import {
  REFRESH_TOKEN_REPOSITORY,
  RefreshTokenRepository,
} from '../domain/refresh-token.repository';

export interface SessionView {
  familyId: string;
  createdAt: Date;
  current: boolean;
}

@Injectable()
export class ListSessionsUseCase {
  constructor(
    @Inject(REFRESH_TOKEN_REPOSITORY)
    private readonly refreshTokens: RefreshTokenRepository,
  ) {}

  // currentFamilyId 는 요청한 액세스 토큰의 fam 클레임이다.
  // 없으면(배포 전 발급된 구 토큰) 전부 false로 둔다 — 예외를 던지지 않는다.
  async execute(
    userId: string,
    currentFamilyId?: string,
  ): Promise<SessionView[]> {
    const families = await this.refreshTokens.findActiveFamilies(
      userId,
      new Date(),
    );
    return families.map((family) => ({
      familyId: family.familyId,
      createdAt: family.createdAt,
      current: family.familyId === currentFamilyId,
    }));
  }
}
