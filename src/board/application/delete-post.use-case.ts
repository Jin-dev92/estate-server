import { Inject, Injectable } from '@nestjs/common';
import { POST_REPOSITORY, PostRepository } from '../domain/post.repository';
import { BOARD_CACHE, BoardCache } from './board-cache';
import { LIKE_COUNTER, LikeCounter } from './like-counter';
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
    @Inject(LIKE_COUNTER) private readonly likeCounter: LikeCounter,
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
    // 파생 좋아요 카운터 키도 함께 제거(orphan 방지 · Delete 무효화 컨벤션).
    await this.likeCounter.remove(input.postId);
  }
}
