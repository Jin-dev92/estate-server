import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PostLikeRepository } from '../domain/post-like.repository';
import { TransactionClient } from '../../outbox/domain/transaction-runner';

@Injectable()
export class PrismaPostLikeRepository implements PostLikeRepository {
  constructor(private readonly prisma: PrismaService) {}

  async like(
    postId: string,
    userId: string,
    tx?: TransactionClient,
  ): Promise<boolean> {
    const db = tx ?? this.prisma;
    // ON CONFLICT DO NOTHING. 유니크 제약이 동시 insert를 직렬화 → 정확히 하나만 count 1.
    const { count } = await db.postLike.createMany({
      data: [{ postId, userId }],
      skipDuplicates: true,
    });
    return count === 1;
  }

  async unlike(
    postId: string,
    userId: string,
    tx?: TransactionClient,
  ): Promise<boolean> {
    const db = tx ?? this.prisma;
    const { count } = await db.postLike.deleteMany({
      where: { postId, userId },
    });
    return count === 1;
  }

  async countByPost(postId: string): Promise<number> {
    return this.prisma.postLike.count({ where: { postId } });
  }

  async countByPosts(postIds: string[]): Promise<Map<string, number>> {
    if (postIds.length === 0) return new Map();
    const rows = await this.prisma.postLike.groupBy({
      by: ['postId'],
      where: { postId: { in: postIds } },
      _count: { _all: true },
    });
    return new Map(rows.map((r) => [r.postId, r._count._all]));
  }

  async likedPostIds(userId: string, postIds: string[]): Promise<Set<string>> {
    if (postIds.length === 0) return new Set();
    const rows = await this.prisma.postLike.findMany({
      where: { userId, postId: { in: postIds } },
      select: { postId: true },
    });
    return new Set(rows.map((r) => r.postId));
  }

  async hasLiked(postId: string, userId: string): Promise<boolean> {
    const row = await this.prisma.postLike.findUnique({
      where: { postId_userId: { postId, userId } },
      select: { id: true },
    });
    return row !== null;
  }
}
