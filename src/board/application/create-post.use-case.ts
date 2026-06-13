import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Post } from '../domain/post.entity';
import { PostCategory } from '../domain/post-category.enum';
import { POST_REPOSITORY, PostRepository } from '../domain/post.repository';
import { BOARD_CACHE, BoardCache } from './board-cache';
import { MEMBERSHIP_CHECKER, MembershipChecker } from './membership';
import { AppException } from '../../common/errors/app-exception';
import { BoardError } from '../board.errors';
import { EVENT_PUBLISHER, EventPublisher } from '../../events/event-publisher';
import { EventType, EntityType } from '../../events/event-type.enum';

export interface CreatePostInput {
  userId: string;
  buildingId: string;
  category?: PostCategory;
  title: string;
  content: string;
}

@Injectable()
export class CreatePostUseCase {
  constructor(
    @Inject(POST_REPOSITORY) private readonly posts: PostRepository,
    @Inject(BOARD_CACHE) private readonly cache: BoardCache,
    @Inject(MEMBERSHIP_CHECKER) private readonly membership: MembershipChecker,
    @Inject(EVENT_PUBLISHER) private readonly events: EventPublisher,
  ) {}

  async execute(input: CreatePostInput): Promise<Post> {
    const ok = await this.membership.isMember(input.userId, input.buildingId);
    if (!ok) throw new AppException(BoardError.NOT_BUILDING_MEMBER);

    const post = Post.create({
      buildingId: input.buildingId,
      authorId: input.userId,
      category: input.category,
      title: input.title,
      content: input.content,
    });
    const saved = await this.posts.create(post);
    await this.cache.invalidateList(input.buildingId);
    await this.events.publish({
      eventId: randomUUID(),
      eventType: EventType.PostCreated,
      occurredAt: new Date().toISOString(),
      actorId: input.userId,
      entityType: EntityType.Post,
      entityId: saved.id!,
      payload: {
        buildingId: saved.buildingId,
        category: saved.category,
        title: saved.title,
      },
    });
    return saved;
  }
}
