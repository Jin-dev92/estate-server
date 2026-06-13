import { Inject, Injectable } from '@nestjs/common';
import { Post } from '../domain/post.entity';
import { PostCategory } from '../domain/post-category.enum';
import { POST_REPOSITORY, PostRepository } from '../domain/post.repository';
import { BOARD_CACHE, BoardCache } from './board-cache';
import { MEMBERSHIP_CHECKER, MembershipChecker } from './membership';
import { AppException } from '../../common/errors/app-exception';
import { BoardError } from '../board.errors';

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
    return saved;
  }
}
