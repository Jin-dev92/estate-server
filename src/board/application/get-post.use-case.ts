import { Inject, Injectable } from '@nestjs/common';
import { POST_REPOSITORY, PostRepository } from '../domain/post.repository';
import {
  COMMENT_REPOSITORY,
  CommentRepository,
} from '../domain/comment.repository';
import {
  POST_LIKE_REPOSITORY,
  PostLikeRepository,
} from '../domain/post-like.repository';
import {
  BOARD_CACHE,
  BoardCache,
  PostDetail,
  PostDetailView,
} from './board-cache';
import { MEMBERSHIP_CHECKER, MembershipChecker } from './membership';
import { AppException } from '../../common/errors/app-exception';
import { BoardError } from '../board.errors';

export interface GetPostInput {
  userId: string;
  postId: string;
}

@Injectable()
export class GetPostUseCase {
  constructor(
    @Inject(POST_REPOSITORY) private readonly posts: PostRepository,
    @Inject(COMMENT_REPOSITORY) private readonly comments: CommentRepository,
    @Inject(BOARD_CACHE) private readonly cache: BoardCache,
    @Inject(MEMBERSHIP_CHECKER) private readonly membership: MembershipChecker,
    @Inject(POST_LIKE_REPOSITORY) private readonly likes: PostLikeRepository,
  ) {}

  async execute(input: GetPostInput): Promise<PostDetailView> {
    const detail = await this.loadDetail(input);

    // 좋아요 정보는 캐시에 넣지 않고 매 조회 시 라이브로 병합(§6).
    // count와 liked는 서로 독립적이므로 병렬 조회로 라운드트립을 줄인다.
    const [likeCount, likedByMe] = await Promise.all([
      this.likes.countByPost(input.postId),
      this.likes.hasLiked(input.postId, input.userId),
    ]);
    return { ...detail, likeCount, likedByMe };
  }

  // 정적 본문(캐시된 또는 새로 구성한 PostDetail)을 반환. 인가 포함.
  private async loadDetail(input: GetPostInput): Promise<PostDetail> {
    const cached = await this.cache.getDetail(input.postId);
    if (cached) {
      await this.authorize(input.userId, cached.buildingId);
      return cached;
    }

    const post = await this.posts.findById(input.postId);
    if (!post) throw new AppException(BoardError.POST_NOT_FOUND);
    await this.authorize(input.userId, post.buildingId);

    const comments = await this.comments.findByPost(input.postId);
    const detail: PostDetail = {
      id: post.id!,
      buildingId: post.buildingId,
      category: post.category,
      title: post.title,
      content: post.content,
      authorId: post.authorId,
      comments: comments.map((c) => ({
        id: c.id!,
        authorId: c.authorId,
        content: c.content,
      })),
    };
    await this.cache.setDetail(input.postId, detail);
    return detail;
  }

  private async authorize(userId: string, buildingId: string): Promise<void> {
    const ok = await this.membership.isMember(userId, buildingId);
    if (!ok) throw new AppException(BoardError.NOT_BUILDING_MEMBER);
  }
}
