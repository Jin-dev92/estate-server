import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { TransactionClient } from '../../outbox/domain/transaction-runner';
import { RefreshToken } from '../domain/refresh-token.entity';
import {
  RefreshTokenRepository,
  SessionSummary,
} from '../domain/refresh-token.repository';

// Prisma 행 → 도메인 엔티티 매핑에 쓰는 최소 형태.
interface RefreshTokenRow {
  id: string;
  userId: string;
  tokenHash: string;
  familyId: string;
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
}

@Injectable()
export class PrismaRefreshTokenRepository implements RefreshTokenRepository {
  constructor(private readonly prisma: PrismaService) {}

  // tx가 주어지면 그 트랜잭션 클라이언트를 쓴다(회전의 원자성 확보).
  private client(tx?: TransactionClient) {
    return (tx ?? this.prisma).refreshToken;
  }

  private toEntity(row: RefreshTokenRow): RefreshToken {
    return RefreshToken.reconstitute({
      id: row.id,
      userId: row.userId,
      tokenHash: row.tokenHash,
      familyId: row.familyId,
      expiresAt: row.expiresAt,
      usedAt: row.usedAt,
      revokedAt: row.revokedAt,
    });
  }

  async save(
    token: RefreshToken,
    tx?: TransactionClient,
  ): Promise<RefreshToken> {
    const row = await this.client(tx).create({
      data: {
        userId: token.userId,
        tokenHash: token.tokenHash,
        familyId: token.familyId,
        expiresAt: token.expiresAt,
      },
    });
    return this.toEntity(row);
  }

  async findByHash(tokenHash: string): Promise<RefreshToken | null> {
    const row = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
    });
    return row ? this.toEntity(row) : null;
  }

  async markUsed(
    id: string,
    usedAt: Date,
    tx?: TransactionClient,
  ): Promise<number> {
    // 조건 없는 update는 동시 요청 둘 다 통과시킨다(둘 다 usedAt: null을
    // 읽었다면 나중 UPDATE가 그냥 덮어씀 — 에러 없음). where에 usedAt: null을
    // 조건으로 걸어 compare-and-set으로 만든다: 먼저 커밋하는 쪽만 count=1,
    // 진 쪽은 count=0을 받아 재사용 판정의 근거가 된다.
    const { count } = await this.client(tx).updateMany({
      where: { id, usedAt: null },
      data: { usedAt },
    });
    return count;
  }

  async revokeFamily(
    familyId: string,
    revokedAt: Date,
    tx?: TransactionClient,
  ): Promise<number> {
    // revokedAt: null 조건을 두어 이미 폐기된 행의 시각을 덮어쓰지 않는다.
    // 최초 폐기 시각이 사후 조사의 근거이므로 보존해야 한다.
    const { count } = await this.client(tx).updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt },
    });
    return count;
  }

  async revokeAllByUser(
    userId: string,
    revokedAt: Date,
    tx?: TransactionClient,
  ): Promise<number> {
    const { count } = await this.client(tx).updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt },
    });
    return count;
  }

  async findActiveFamilies(
    userId: string,
    now: Date,
  ): Promise<SessionSummary[]> {
    // 1단계: 활성 familyId 집합. 회전이 이전 행에 usedAt을 찍고 새 행을
    // 넣는 구조라, 한 가족에서 usedAt: null인 행은 항상 최대 1개다 —
    // 즉 여기서 얻는 건 "가족별 최신 행"이지 로그인 시각이 아니다.
    const active = await this.prisma.refreshToken.findMany({
      where: {
        userId,
        usedAt: null,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      select: { familyId: true },
    });
    if (active.length === 0) return [];
    const familyIds = active.map((row) => row.familyId);

    // 2단계: 로그인 시각은 그 가족의 "첫 행"의 createdAt이다. 첫 행은 이미
    // 회전으로 소비돼 usedAt이 채워져 있으므로, 여기서는 usedAt·revokedAt
    // 조건을 걸지 않고 familyId로만 최솟값을 구한다.
    // orderBy 없이 두면 반환 순서가 DB에 맡겨져 매 요청마다 흔들린다.
    // 세션 목록 UI는 순서가 결정적이어야 하므로 로그인 시각(MIN(createdAt))
    // 기준 최신순(desc)으로 정렬한다 — 방금 로그인한 세션이 목록 위에
    // 보이는 편이 사용자가 "지금 이 세션"을 찾기 쉽다.
    const grouped = await this.prisma.refreshToken.groupBy({
      by: ['familyId'],
      where: { userId, familyId: { in: familyIds } },
      _min: { createdAt: true },
      orderBy: { _min: { createdAt: 'desc' } },
    });
    return grouped
      .filter((g) => g._min.createdAt != null)
      .map((g) => ({
        familyId: g.familyId,
        createdAt: g._min.createdAt as Date,
      }));
  }

  async findFamilyOwner(familyId: string): Promise<string | null> {
    const row = await this.prisma.refreshToken.findFirst({
      where: { familyId },
      select: { userId: true },
    });
    return row?.userId ?? null;
  }
}
