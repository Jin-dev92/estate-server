import { Inject, Injectable, Logger } from '@nestjs/common';
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
import { LIKE_COUNTER, LikeCounter } from './like-counter';
import { LikeCountReader } from './like-count-reader';

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
  private readonly logger = new Logger(UnlikePostUseCase.name);

  constructor(
    @Inject(POST_REPOSITORY) private readonly posts: PostRepository,
    @Inject(POST_LIKE_REPOSITORY) private readonly likes: PostLikeRepository,
    @Inject(MEMBERSHIP_CHECKER) private readonly membership: MembershipChecker,
    @Inject(TRANSACTION_RUNNER) private readonly txRunner: TransactionRunner,
    @Inject(LIKE_COUNTER) private readonly counter: LikeCounter,
    private readonly reader: LikeCountReader,
  ) {}

  async execute(input: UnlikePostInput): Promise<UnlikePostResult> {
    const post = await this.posts.findById(input.postId);
    if (!post) throw new AppException(BoardError.POST_NOT_FOUND);
    const ok = await this.membership.isMember(input.userId, post.buildingId);
    if (!ok) throw new AppException(BoardError.NOT_BUILDING_MEMBER);

    // 취소는 멱등 물리삭제(없으면 no-op). 이벤트는 발행하지 않는다.
    let removed = false;
    await this.txRunner.run(async (tx) => {
      removed = await this.likes.unlike(input.postId, input.userId, tx);
    });

    // 카운터 갱신은 커밋 후 + 실제 전이 시에만, best-effort.
    if (removed) {
      try {
        await this.counter.decrement(input.postId);
      } catch (err) {
        this.logger.warn(
          `좋아요 카운터 감소 실패(무시): ${(err as Error).message}`,
        );
      }
    }

    const likeCount = await this.reader.readOne(input.postId);
    return { postId: input.postId, liked: false, likeCount };
  }
}
