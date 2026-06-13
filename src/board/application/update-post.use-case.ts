import { Inject, Injectable } from '@nestjs/common';
import { Post } from '../domain/post.entity';
import { POST_REPOSITORY, PostRepository } from '../domain/post.repository';
import { BOARD_CACHE, BoardCache } from './board-cache';
import { AppException } from '../../common/errors/app-exception';
import { BoardError } from '../board.errors';

export interface UpdatePostInput {
  userId: string;
  postId: string;
  title: string;
  content: string;
}

@Injectable()
export class UpdatePostUseCase {
  constructor(
    @Inject(POST_REPOSITORY) private readonly posts: PostRepository,
    @Inject(BOARD_CACHE) private readonly cache: BoardCache,
  ) {}

  async execute(input: UpdatePostInput): Promise<Post> {
    const post = await this.posts.findById(input.postId);
    if (!post) throw new AppException(BoardError.POST_NOT_FOUND);
    if (!post.isAuthoredBy(input.userId)) {
      throw new AppException(BoardError.NOT_AUTHOR);
    }
    const updated = await this.posts.update(
      post.edit({ title: input.title, content: input.content }),
    );
    await this.cache.invalidateDetail(input.postId);
    await this.cache.invalidateList(post.buildingId);
    return updated;
  }
}
