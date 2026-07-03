import { Inject, Injectable } from '@nestjs/common';
import { POST_REPOSITORY, PostRepository } from '../domain/post.repository';
import {
  POST_LIKE_REPOSITORY,
  PostLikeRepository,
} from '../domain/post-like.repository';
import { MEMBERSHIP_CHECKER, MembershipChecker } from './membership';
import { AppException } from '../../common/errors/app-exception';
import { BoardError } from '../board.errors';
import {
  TRANSACTION_RUNNER,
  TransactionRunner,
} from '../../outbox/domain/transaction-runner';

export interface UnlikePostInput {
  userId: string;
  postId: string;
}

export interface UnlikePostResult {
  postId: string;
  liked: false;
  likeCount: number;
}

@Injectable()
export class UnlikePostUseCase {
  constructor(
    @Inject(POST_REPOSITORY) private readonly posts: PostRepository,
    @Inject(POST_LIKE_REPOSITORY) private readonly likes: PostLikeRepository,
    @Inject(MEMBERSHIP_CHECKER) private readonly membership: MembershipChecker,
    @Inject(TRANSACTION_RUNNER) private readonly txRunner: TransactionRunner,
  ) {}

  async execute(input: UnlikePostInput): Promise<UnlikePostResult> {
    const post = await this.posts.findById(input.postId);
    if (!post) throw new AppException(BoardError.POST_NOT_FOUND);
    const ok = await this.membership.isMember(input.userId, post.buildingId);
    if (!ok) throw new AppException(BoardError.NOT_BUILDING_MEMBER);

    // 취소는 멱등 물리삭제(없으면 no-op). 이벤트는 발행하지 않는다.
    await this.txRunner.run(async (tx) => {
      await this.likes.unlike(input.postId, input.userId, tx);
    });

    const likeCount = await this.likes.countByPost(input.postId);
    return { postId: input.postId, liked: false, likeCount };
  }
}
