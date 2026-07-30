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
    return this.toEntity(row as RefreshTokenRow);
  }

  async findByHash(tokenHash: string): Promise<RefreshToken | null> {
    const row = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
    });
    return row ? this.toEntity(row as RefreshTokenRow) : null;
  }

  async markUsed(
    id: string,
    usedAt: Date,
    tx?: TransactionClient,
  ): Promise<void> {
    await this.client(tx).update({ where: { id }, data: { usedAt } });
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
    const rows = await this.prisma.refreshToken.findMany({
      where: {
        userId,
        usedAt: null,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      select: { familyId: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });

    // 가족별로 묶고 최초 createdAt(= 로그인 시각)만 남긴다.
    // orderBy asc 이므로 먼저 만난 행이 가장 이르다.
    const byFamily = new Map<string, Date>();
    for (const row of rows) {
      if (!byFamily.has(row.familyId)) {
        byFamily.set(row.familyId, row.createdAt);
      }
    }
    return [...byFamily].map(([familyId, createdAt]) => ({
      familyId,
      createdAt,
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
