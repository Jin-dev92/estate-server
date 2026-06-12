import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/interface/jwt-auth.guard';
import { CurrentUser } from '../../auth/interface/current-user.decorator';
import { TokenPayload } from '../../auth/domain/token-issuer';
import { CreatePostUseCase } from '../application/create-post.use-case';
import { ListPostsUseCase } from '../application/list-posts.use-case';
import { GetPostUseCase } from '../application/get-post.use-case';
import { UpdatePostUseCase } from '../application/update-post.use-case';
import { DeletePostUseCase } from '../application/delete-post.use-case';
import { CreateCommentUseCase } from '../application/create-comment.use-case';
import { CreatePostDto } from './dto/create-post.dto';
import { UpdatePostDto } from './dto/update-post.dto';
import { CreateCommentDto } from './dto/create-comment.dto';

@Controller()
@UseGuards(JwtAuthGuard)
export class BoardController {
  constructor(
    private readonly createPost: CreatePostUseCase,
    private readonly listPosts: ListPostsUseCase,
    private readonly getPost: GetPostUseCase,
    private readonly updatePost: UpdatePostUseCase,
    private readonly deletePost: DeletePostUseCase,
    private readonly createComment: CreateCommentUseCase,
  ) {}

  @Post('buildings/:buildingId/posts')
  async createPostHandler(
    @CurrentUser() user: TokenPayload,
    @Param('buildingId') buildingId: string,
    @Body() dto: CreatePostDto,
  ) {
    const post = await this.createPost.execute({
      userId: user.sub,
      buildingId,
      category: dto.category,
      title: dto.title,
      content: dto.content,
    });
    return {
      id: post.id,
      buildingId: post.buildingId,
      category: post.category,
      title: post.title,
    };
  }

  @Get('buildings/:buildingId/posts')
  listPostsHandler(
    @CurrentUser() user: TokenPayload,
    @Param('buildingId') buildingId: string,
  ) {
    return this.listPosts.execute({ userId: user.sub, buildingId });
  }

  @Get('posts/:postId')
  getPostHandler(
    @CurrentUser() user: TokenPayload,
    @Param('postId') postId: string,
  ) {
    return this.getPost.execute({ userId: user.sub, postId });
  }

  @Patch('posts/:postId')
  async updatePostHandler(
    @CurrentUser() user: TokenPayload,
    @Param('postId') postId: string,
    @Body() dto: UpdatePostDto,
  ) {
    const post = await this.updatePost.execute({
      userId: user.sub,
      postId,
      title: dto.title,
      content: dto.content,
    });
    return { id: post.id, title: post.title, content: post.content };
  }

  @Delete('posts/:postId')
  @HttpCode(204)
  async deletePostHandler(
    @CurrentUser() user: TokenPayload,
    @Param('postId') postId: string,
  ): Promise<void> {
    await this.deletePost.execute({ userId: user.sub, postId });
  }

  @Post('posts/:postId/comments')
  async createCommentHandler(
    @CurrentUser() user: TokenPayload,
    @Param('postId') postId: string,
    @Body() dto: CreateCommentDto,
  ) {
    const comment = await this.createComment.execute({
      userId: user.sub,
      postId,
      content: dto.content,
    });
    return { id: comment.id, postId: comment.postId, content: comment.content };
  }
}
