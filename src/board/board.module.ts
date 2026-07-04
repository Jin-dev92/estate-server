import { Module } from '@nestjs/common';
import { BoardController } from './interface/board.controller';
import { CreatePostUseCase } from './application/create-post.use-case';
import { ListPostsUseCase } from './application/list-posts.use-case';
import { GetPostUseCase } from './application/get-post.use-case';
import { UpdatePostUseCase } from './application/update-post.use-case';
import { DeletePostUseCase } from './application/delete-post.use-case';
import { CreateCommentUseCase } from './application/create-comment.use-case';
import { LikePostUseCase } from './application/like-post.use-case';
import { UnlikePostUseCase } from './application/unlike-post.use-case';
import { POST_REPOSITORY } from './domain/post.repository';
import { COMMENT_REPOSITORY } from './domain/comment.repository';
import { POST_LIKE_REPOSITORY } from './domain/post-like.repository';
import { BOARD_CACHE } from './application/board-cache';
import { MEMBERSHIP_CHECKER } from './application/membership';
import { LIKE_COUNTER } from './application/like-counter';
import { PrismaPostRepository } from './infrastructure/prisma-post.repository';
import { PrismaCommentRepository } from './infrastructure/prisma-comment.repository';
import { PrismaPostLikeRepository } from './infrastructure/prisma-post-like.repository';
import { RedisBoardCache } from './infrastructure/redis-board-cache';
import { RedisLikeCounter } from './infrastructure/redis-like-counter';
import { PrismaMembershipChecker } from './infrastructure/prisma-membership.checker';
import { OutboxModule } from '../outbox/outbox.module';

@Module({
  imports: [OutboxModule],
  controllers: [BoardController],
  providers: [
    CreatePostUseCase,
    ListPostsUseCase,
    GetPostUseCase,
    UpdatePostUseCase,
    DeletePostUseCase,
    CreateCommentUseCase,
    LikePostUseCase,
    UnlikePostUseCase,
    { provide: POST_REPOSITORY, useClass: PrismaPostRepository },
    { provide: COMMENT_REPOSITORY, useClass: PrismaCommentRepository },
    { provide: POST_LIKE_REPOSITORY, useClass: PrismaPostLikeRepository },
    { provide: BOARD_CACHE, useClass: RedisBoardCache },
    { provide: MEMBERSHIP_CHECKER, useClass: PrismaMembershipChecker },
    { provide: LIKE_COUNTER, useClass: RedisLikeCounter },
  ],
  exports: [MEMBERSHIP_CHECKER],
})
export class BoardModule {}
