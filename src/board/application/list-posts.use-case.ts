import { Inject, Injectable } from '@nestjs/common';
import { POST_REPOSITORY, PostRepository } from '../domain/post.repository';
import {
  POST_LIKE_REPOSITORY,
  PostLikeRepository,
} from '../domain/post-like.repository';
import {
  BOARD_CACHE,
  BoardCache,
  PostSummary,
  PostSummaryView,
} from './board-cache';
import { MEMBERSHIP_CHECKER, MembershipChecker } from './membership';
import { AppException } from '../../common/errors/app-exception';
import { BoardError } from '../board.errors';
import { LikeCountReader } from './like-count-reader';

export interface ListPostsInput {
  userId: string;
  buildingId: string;
}

@Injectable()
export class ListPostsUseCase {
  constructor(
    @Inject(POST_REPOSITORY) private readonly posts: PostRepository,
    @Inject(BOARD_CACHE) private readonly cache: BoardCache,
    @Inject(MEMBERSHIP_CHECKER) private readonly membership: MembershipChecker,
    @Inject(POST_LIKE_REPOSITORY) private readonly likes: PostLikeRepository,
    private readonly reader: LikeCountReader,
  ) {}

  async execute(input: ListPostsInput): Promise<PostSummaryView[]> {
    const ok = await this.membership.isMember(input.userId, input.buildingId);
    if (!ok) throw new AppException(BoardError.NOT_BUILDING_MEMBER);

    const summaries = await this.loadSummaries(input.buildingId);

    // 좋아요 수는 카운터 우선 배치(미스만 COUNT), likedByMe는 유저별이라 DB 배치.
    const postIds = summaries.map((s) => s.id);
    const [counts, liked] = await Promise.all([
      this.reader.readMany(postIds),
      this.likes.likedPostIds(input.userId, postIds),
    ]);
    return summaries.map((s) => ({
      ...s,
      likeCount: counts.get(s.id) ?? 0,
      likedByMe: liked.has(s.id),
    }));
  }

  private async loadSummaries(buildingId: string): Promise<PostSummary[]> {
    const cached = await this.cache.getList(buildingId);
    if (cached) return cached;

    const posts = await this.posts.findByBuilding(buildingId);
    const summaries: PostSummary[] = posts.map((p) => ({
      id: p.id!,
      category: p.category,
      title: p.title,
      authorId: p.authorId,
    }));
    await this.cache.setList(buildingId, summaries);
    return summaries;
  }
}
