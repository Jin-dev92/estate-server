import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Comment } from '../domain/comment.entity';
import { POST_REPOSITORY, PostRepository } from '../domain/post.repository';
import {
  COMMENT_REPOSITORY,
  CommentRepository,
} from '../domain/comment.repository';
import { BOARD_CACHE, BoardCache } from './board-cache';
import { MEMBERSHIP_CHECKER, MembershipChecker } from './membership';
import { AppException } from '../../common/errors/app-exception';
import { BoardError } from '../board.errors';
import { EVENT_PUBLISHER, EventPublisher } from '../../events/event-publisher';
import { EventType, EntityType } from '../../events/event-type.enum';

export interface CreateCommentInput {
  userId: string;
  postId: string;
  content: string;
}

@Injectable()
export class CreateCommentUseCase {
  constructor(
    @Inject(COMMENT_REPOSITORY) private readonly comments: CommentRepository,
    @Inject(POST_REPOSITORY) private readonly posts: PostRepository,
    @Inject(BOARD_CACHE) private readonly cache: BoardCache,
    @Inject(MEMBERSHIP_CHECKER) private readonly membership: MembershipChecker,
    @Inject(EVENT_PUBLISHER) private readonly events: EventPublisher,
  ) {}

  async execute(input: CreateCommentInput): Promise<Comment> {
    const post = await this.posts.findById(input.postId);
    if (!post) throw new AppException(BoardError.POST_NOT_FOUND);
    const ok = await this.membership.isMember(input.userId, post.buildingId);
    if (!ok) throw new AppException(BoardError.NOT_BUILDING_MEMBER);

    const saved = await this.comments.create(
      Comment.create({
        postId: input.postId,
        authorId: input.userId,
        content: input.content,
      }),
    );
    await this.cache.invalidateDetail(input.postId);
    await this.events.publish({
      eventId: randomUUID(),
      eventType: EventType.CommentCreated,
      occurredAt: new Date().toISOString(),
      actorId: input.userId,
      entityType: EntityType.Comment,
      entityId: saved.id!,
      payload: { postId: saved.postId },
    });
    return saved;
  }
}
