import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/interface/jwt-auth.guard';
import { CurrentUser } from '../../auth/interface/current-user.decorator';
import { TokenPayload } from '../../auth/domain/token-issuer';
import { ErrorResponseDto } from '../../common/errors/error-response.dto';
import { SWAGGER_BEARER_AUTH } from '../../common/swagger/swagger.constants';
import { EnsureRoomUseCase } from '../application/ensure-room.use-case';
import { ListRoomsUseCase } from '../application/list-rooms.use-case';
import { GetMessagesUseCase } from '../application/get-messages.use-case';
import { RECENT_LIMIT } from '../infrastructure/redis-message-cache';
import { EnsureRoomDto } from './dto/ensure-room.dto';

@ApiTags('chat')
@ApiBearerAuth(SWAGGER_BEARER_AUTH)
@UseGuards(JwtAuthGuard)
@Controller('chat')
export class ChatController {
  constructor(
    private readonly ensureRoom: EnsureRoomUseCase,
    private readonly listRooms: ListRoomsUseCase,
    private readonly getMessages: GetMessagesUseCase,
  ) {}

  @Post('rooms')
  @ApiOperation({ summary: '채팅방 생성/조회(ensure)' })
  @ApiResponse({ status: 201, description: '방' })
  @ApiResponse({ status: 403, type: ErrorResponseDto, description: '권한 없음' })
  async createRoom(@CurrentUser() user: TokenPayload, @Body() dto: EnsureRoomDto) {
    const room = await this.ensureRoom.execute({ userId: user.sub, buildingId: dto.buildingId, tenantId: dto.tenantId });
    return { id: room.id, buildingId: room.buildingId, ownerId: room.ownerId, tenantId: room.tenantId };
  }

  @Get('rooms')
  @ApiOperation({ summary: '내 채팅방 목록' })
  @ApiResponse({ status: 200, description: '방 목록' })
  async myRooms(@CurrentUser() user: TokenPayload) {
    const rooms = await this.listRooms.execute(user.sub);
    return rooms.map((r) => ({ id: r.id, buildingId: r.buildingId, ownerId: r.ownerId, tenantId: r.tenantId }));
  }

  @Get('rooms/:id/messages')
  @ApiOperation({ summary: '메시지 히스토리(최신순)' })
  @ApiResponse({ status: 200, description: '메시지 목록' })
  @ApiResponse({ status: 403, type: ErrorResponseDto, description: '참가자 아님' })
  async messages(
    @CurrentUser() user: TokenPayload,
    @Param('id') id: string,
    @Query('limit') limit?: string,
  ) {
    const n = Math.min(Number(limit) || RECENT_LIMIT, RECENT_LIMIT);
    return this.getMessages.execute({ userId: user.sub, roomId: id, limit: n });
  }
}
