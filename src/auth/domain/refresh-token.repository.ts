import { TransactionClient } from '../../outbox/domain/transaction-runner';
import { RefreshToken } from './refresh-token.entity';

export const REFRESH_TOKEN_REPOSITORY = Symbol('REFRESH_TOKEN_REPOSITORY');

// 세션 목록 한 줄. ip·userAgent를 저장하지 않기로 했으므로(스펙 §1 제외 4번)
// 노출할 수 있는 정보는 가족 식별자와 로그인 시각뿐이다.
export interface SessionSummary {
  familyId: string;
  createdAt: Date;
}

export interface RefreshTokenRepository {
  save(token: RefreshToken, tx?: TransactionClient): Promise<RefreshToken>;
  findByHash(tokenHash: string): Promise<RefreshToken | null>;
  // 반환값은 실제로 갱신된 행 수(compare-and-set 결과). 0이면 이미 다른
  // 요청이 같은 토큰을 소비했다는 뜻 — 호출부가 재사용으로 판정한다.
  markUsed(id: string, usedAt: Date, tx?: TransactionClient): Promise<number>;
  // 반환값은 폐기된 행 수. 재사용 탐지 로깅에 쓴다.
  revokeFamily(
    familyId: string,
    revokedAt: Date,
    tx?: TransactionClient,
  ): Promise<number>;
  revokeAllByUser(
    userId: string,
    revokedAt: Date,
    tx?: TransactionClient,
  ): Promise<number>;
  // 활성 가족 목록. createdAt은 그 가족의 최초 발급 시각(= 로그인 시각).
  findActiveFamilies(userId: string, now: Date): Promise<SessionSummary[]>;
  // 소유권 검사용. 가족이 없으면 null.
  findFamilyOwner(familyId: string): Promise<string | null>;
}
