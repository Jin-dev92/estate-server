import { Inject, Injectable } from '@nestjs/common';
import { POST_REPOSITORY, PostRepository } from '../domain/post.repository';
import {
  COMMENT_REPOSITORY,
  CommentRepository,
} from '../domain/comment.repository';
import { BOARD_CACHE, BoardCache, PostDetail } from './board-cache';
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
  ) {}

  async execute(input: GetPostInput): Promise<PostDetail> {
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
