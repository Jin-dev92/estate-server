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
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/interface/jwt-auth.guard';
import { CurrentUser } from '../../auth/interface/current-user.decorator';
import { TokenPayload } from '../../auth/domain/token-issuer';
import { CreatePostUseCase } from '../application/create-post.use-case';
import { ListPostsUseCase } from '../application/list-posts.use-case';
import { GetPostUseCase } from '../application/get-post.use-case';
import { UpdatePostUseCase } from '../application/update-post.use-case';
import { DeletePostUseCase } from '../application/delete-post.use-case';
import { CreateCommentUseCase } from '../application/create-comment.use-case';
import { LikePostUseCase } from '../application/like-post.use-case';
import { UnlikePostUseCase } from '../application/unlike-post.use-case';
import { CreatePostDto } from './dto/create-post.dto';
import { UpdatePostDto } from './dto/update-post.dto';
import { CreateCommentDto } from './dto/create-comment.dto';
import { ErrorResponseDto } from '../../common/errors/error-response.dto';
import { SWAGGER_BEARER_AUTH } from '../../common/swagger/swagger.constants';

@ApiTags('board')
// 모든 라우트가 JwtAuthGuard 로 보호되므로 클래스 레벨에 한 번만 선언한다.
@ApiBearerAuth(SWAGGER_BEARER_AUTH)
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
    private readonly likePost: LikePostUseCase,
    private readonly unlikePost: UnlikePostUseCase,
  ) {}

  @Post('buildings/:buildingId/posts')
  @ApiParam({ name: 'buildingId', description: '게시글을 작성할 건물 ID' })
  @ApiOperation({ summary: '게시글 작성(건물 멤버 전용)' })
  @ApiResponse({ status: 201, description: '생성된 게시글' })
  @ApiResponse({
    status: 403,
    type: ErrorResponseDto,
    description: '건물 멤버 아님',
  })
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
  @ApiParam({ name: 'buildingId', description: '게시글 목록을 조회할 건물 ID' })
  @ApiOperation({ summary: '게시글 목록 조회(건물 멤버 전용)' })
  @ApiResponse({ status: 200, description: '게시글 목록' })
  @ApiResponse({
    status: 403,
    type: ErrorResponseDto,
    description: '건물 멤버 아님',
  })
  listPostsHandler(
    @CurrentUser() user: TokenPayload,
    @Param('buildingId') buildingId: string,
  ) {
    return this.listPosts.execute({ userId: user.sub, buildingId });
  }

  @Get('posts/:postId')
  @ApiParam({ name: 'postId', description: '조회할 게시글 ID' })
  @ApiOperation({ summary: '게시글 단건 조회(건물 멤버 전용)' })
  @ApiResponse({ status: 200, description: '게시글 상세' })
  @ApiResponse({
    status: 403,
    type: ErrorResponseDto,
    description: '건물 멤버 아님',
  })
  @ApiResponse({
    status: 404,
    type: ErrorResponseDto,
    description: '게시글 없음',
  })
  getPostHandler(
    @CurrentUser() user: TokenPayload,
    @Param('postId') postId: string,
  ) {
    return this.getPost.execute({ userId: user.sub, postId });
  }

  @Patch('posts/:postId')
  @ApiParam({ name: 'postId', description: '수정할 게시글 ID' })
  @ApiOperation({ summary: '게시글 수정(작성자 전용)' })
  @ApiResponse({ status: 200, description: '수정된 게시글' })
  @ApiResponse({
    status: 403,
    type: ErrorResponseDto,
    description: '작성자 아님',
  })
  @ApiResponse({
    status: 404,
    type: ErrorResponseDto,
    description: '게시글 없음',
  })
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
  @ApiParam({ name: 'postId', description: '삭제할 게시글 ID' })
  @ApiOperation({ summary: '게시글 삭제(작성자 전용)' })
  @ApiResponse({ status: 204, description: '삭제 완료(본문 없음)' })
  @ApiResponse({
    status: 403,
    type: ErrorResponseDto,
    description: '작성자 아님',
  })
  @ApiResponse({
    status: 404,
    type: ErrorResponseDto,
    description: '게시글 없음',
  })
  async deletePostHandler(
    @CurrentUser() user: TokenPayload,
    @Param('postId') postId: string,
  ): Promise<void> {
    await this.deletePost.execute({ userId: user.sub, postId });
  }

  @Post('posts/:postId/comments')
  @ApiParam({ name: 'postId', description: '댓글을 작성할 게시글 ID' })
  @ApiOperation({ summary: '댓글 작성(건물 멤버 전용)' })
  @ApiResponse({ status: 201, description: '생성된 댓글' })
  @ApiResponse({
    status: 403,
    type: ErrorResponseDto,
    description: '건물 멤버 아님',
  })
  @ApiResponse({
    status: 404,
    type: ErrorResponseDto,
    description: '게시글 없음',
  })
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

  @Post('posts/:postId/likes')
  @ApiParam({ name: 'postId', description: '좋아요할 게시글 ID' })
  @ApiOperation({ summary: '게시글 좋아요(멱등, 건물 멤버 전용)' })
  @ApiResponse({ status: 201, description: '좋아요 반영 후 상태' })
  @ApiResponse({
    status: 403,
    type: ErrorResponseDto,
    description: '건물 멤버 아님',
  })
  @ApiResponse({
    status: 404,
    type: ErrorResponseDto,
    description: '게시글 없음',
  })
  likePostHandler(
    @CurrentUser() user: TokenPayload,
    @Param('postId') postId: string,
  ) {
    return this.likePost.execute({ userId: user.sub, postId });
  }

  @Delete('posts/:postId/likes')
  @ApiParam({ name: 'postId', description: '좋아요를 취소할 게시글 ID' })
  @ApiOperation({ summary: '게시글 좋아요 취소(멱등, 건물 멤버 전용)' })
  @ApiResponse({ status: 200, description: '좋아요 취소 후 상태' })
  @ApiResponse({
    status: 403,
    type: ErrorResponseDto,
    description: '건물 멤버 아님',
  })
  @ApiResponse({
    status: 404,
    type: ErrorResponseDto,
    description: '게시글 없음',
  })
  unlikePostHandler(
    @CurrentUser() user: TokenPayload,
    @Param('postId') postId: string,
  ) {
    return this.unlikePost.execute({ userId: user.sub, postId });
  }
}
