import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { POST_REPOSITORY, PostRepository } from '../domain/post.repository';
import {
  POST_LIKE_REPOSITORY,
  PostLikeRepository,
} from '../domain/post-like.repository';
import { MEMBERSHIP_CHECKER, MembershipChecker } from './membership';
import { AppException } from '../../common/errors/app-exception';
import { BoardError } from '../board.errors';
import { EventType, EntityType } from '../../events/event-type.enum';
import {
  TRANSACTION_RUNNER,
  TransactionRunner,
} from '../../outbox/domain/transaction-runner';
import { OUTBOX_STORE, OutboxStore } from '../../outbox/domain/outbox-store';

export interface LikePostInput {
  userId: string;
  postId: string;
}

export interface LikePostResult {
  postId: string;
  liked: true;
  likeCount: number;
}

@Injectable()
export class LikePostUseCase {
  constructor(
    @Inject(POST_REPOSITORY) private readonly posts: PostRepository,
    @Inject(POST_LIKE_REPOSITORY) private readonly likes: PostLikeRepository,
    @Inject(MEMBERSHIP_CHECKER) private readonly membership: MembershipChecker,
    @Inject(TRANSACTION_RUNNER) private readonly txRunner: TransactionRunner,
    @Inject(OUTBOX_STORE) private readonly outbox: OutboxStore,
  ) {}

  async execute(input: LikePostInput): Promise<LikePostResult> {
    const post = await this.posts.findById(input.postId);
    if (!post) throw new AppException(BoardError.POST_NOT_FOUND);
    const ok = await this.membership.isMember(input.userId, post.buildingId);
    if (!ok) throw new AppException(BoardError.NOT_BUILDING_MEMBER);

    // 좋아요 insert + outbox 적재를 한 트랜잭션으로. 신규 전이(newlyLiked)일 때만
    // 이벤트를 발행해 재클릭 스팸을 막는다(전이 판단은 DB rowCount 기반).
    await this.txRunner.run(async (tx) => {
      const newlyLiked = await this.likes.like(input.postId, input.userId, tx);
      if (newlyLiked) {
        await this.outbox.add(
          {
            eventId: randomUUID(),
            eventType: EventType.LikeCreated,
            occurredAt: new Date().toISOString(),
            actorId: input.userId,
            entityType: EntityType.Post,
            entityId: input.postId,
            payload: { postId: input.postId, buildingId: post.buildingId },
          },
          tx,
        );
      }
    });

    // 라이브 COUNT — 커밋 후 최신 수치.
    const likeCount = await this.likes.countByPost(input.postId);
    return { postId: input.postId, liked: true, likeCount };
  }
}
