import { Module } from '@nestjs/common';
import { BoardController } from './interface/board.controller';
import { CreatePostUseCase } from './application/create-post.use-case';
import { ListPostsUseCase } from './application/list-posts.use-case';
import { GetPostUseCase } from './application/get-post.use-case';
import { UpdatePostUseCase } from './application/update-post.use-case';
import { DeletePostUseCase } from './application/delete-post.use-case';
import { CreateCommentUseCase } from './application/create-comment.use-case';
import { POST_REPOSITORY } from './domain/post.repository';
import { COMMENT_REPOSITORY } from './domain/comment.repository';
import { BOARD_CACHE } from './application/board-cache';
import { MEMBERSHIP_CHECKER } from './application/membership';
import { PrismaPostRepository } from './infrastructure/prisma-post.repository';
import { PrismaCommentRepository } from './infrastructure/prisma-comment.repository';
import { RedisBoardCache } from './infrastructure/redis-board-cache';
import { PrismaMembershipChecker } from './infrastructure/prisma-membership.checker';

@Module({
  controllers: [BoardController],
  providers: [
    CreatePostUseCase,
    ListPostsUseCase,
    GetPostUseCase,
    UpdatePostUseCase,
    DeletePostUseCase,
    CreateCommentUseCase,
    { provide: POST_REPOSITORY, useClass: PrismaPostRepository },
    { provide: COMMENT_REPOSITORY, useClass: PrismaCommentRepository },
    { provide: BOARD_CACHE, useClass: RedisBoardCache },
    { provide: MEMBERSHIP_CHECKER, useClass: PrismaMembershipChecker },
  ],
})
export class BoardModule {}
