import { Injectable } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import {
  BoardCache,
  PostDetail,
  PostSummary,
} from '../application/board-cache';

const CACHE_TTL_SEC = 120; // 무효화 누락 대비 안전망

@Injectable()
export class RedisBoardCache implements BoardCache {
  constructor(private readonly redis: RedisService) {}

  private listKey(buildingId: string): string {
    return `board:list:${buildingId}`;
  }
  private detailKey(postId: string): string {
    return `board:detail:${postId}`;
  }

  async getList(buildingId: string): Promise<PostSummary[] | null> {
    const raw = await this.redis.get(this.listKey(buildingId));
    return raw ? (JSON.parse(raw) as PostSummary[]) : null;
  }

  async setList(buildingId: string, posts: PostSummary[]): Promise<void> {
    await this.redis.set(
      this.listKey(buildingId),
      JSON.stringify(posts),
      'EX',
      CACHE_TTL_SEC,
    );
  }

  async getDetail(postId: string): Promise<PostDetail | null> {
    const raw = await this.redis.get(this.detailKey(postId));
    return raw ? (JSON.parse(raw) as PostDetail) : null;
  }

  async setDetail(postId: string, detail: PostDetail): Promise<void> {
    await this.redis.set(
      this.detailKey(postId),
      JSON.stringify(detail),
      'EX',
      CACHE_TTL_SEC,
    );
  }

  async invalidateList(buildingId: string): Promise<void> {
    await this.redis.del(this.listKey(buildingId));
  }

  async invalidateDetail(postId: string): Promise<void> {
    await this.redis.del(this.detailKey(postId));
  }
}
