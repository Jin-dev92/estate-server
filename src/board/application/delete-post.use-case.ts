import { Inject, Injectable } from '@nestjs/common';
import { POST_REPOSITORY, PostRepository } from '../domain/post.repository';
import { BOARD_CACHE, BoardCache } from './board-cache';
import { AppException } from '../../common/errors/app-exception';
import { BoardError } from '../board.errors';

export interface DeletePostInput {
  userId: string;
  postId: string;
}

@Injectable()
export class DeletePostUseCase {
  constructor(
    @Inject(POST_REPOSITORY) private readonly posts: PostRepository,
    @Inject(BOARD_CACHE) private readonly cache: BoardCache,
  ) {}

  async execute(input: DeletePostInput): Promise<void> {
    const post = await this.posts.findById(input.postId);
    if (!post) throw new AppException(BoardError.POST_NOT_FOUND);
    if (!post.isAuthoredBy(input.userId)) {
      throw new AppException(BoardError.NOT_AUTHOR);
    }
    await this.posts.delete(input.postId);
    await this.cache.invalidateDetail(input.postId);
    await this.cache.invalidateList(post.buildingId);
  }
}
