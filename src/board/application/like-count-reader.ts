import { Inject, Injectable } from '@nestjs/common';
import { LIKE_COUNTER, LikeCounter } from './like-counter';
import {
  POST_LIKE_REPOSITORY,
  PostLikeRepository,
} from '../domain/post-like.repository';

// "카운터 우선 → 미스만 DB COUNT → SET NX 백필"의 단일 지점.
// 상세·목록·좋아요/취소 응답이 모두 이 경로로 좋아요 수를 읽는다.
@Injectable()
export class LikeCountReader {
  constructor(
    @Inject(LIKE_COUNTER) private readonly counter: LikeCounter,
    @Inject(POST_LIKE_REPOSITORY) private readonly likes: PostLikeRepository,
  ) {}

  async readMany(postIds: string[]): Promise<Map<string, number>> {
    if (postIds.length === 0) return new Map();
    const cached = await this.counter.getMany(postIds);
    const missed = postIds.filter((id) => !cached.has(id));
    if (missed.length === 0) return cached;

    // 미스만 DB 집계. countByPosts는 좋아요 0개인 글을 결과에 안 담으므로
    // 0으로 보정해 백필한다(0도 채워야 다음 조회가 카운터에 적중).
    const counted = await this.likes.countByPosts(missed);
    const rebuilt = new Map(missed.map((id) => [id, counted.get(id) ?? 0]));
    await this.counter.backfill(rebuilt);
    return new Map([...cached, ...rebuilt]);
  }

  async readOne(postId: string): Promise<number> {
    const counts = await this.readMany([postId]);
    return counts.get(postId) ?? 0;
  }
}
