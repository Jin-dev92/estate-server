import { ApiProperty } from '@nestjs/swagger';

// 방 목록 응답의 마지막 메시지(없으면 null).
export class LastMessageDto {
  @ApiProperty({ example: '안녕하세요, 문의드립니다.' })
  content: string;

  @ApiProperty({ example: '2026-06-23T08:00:00.000Z', description: 'ISO 8601' })
  createdAt: string;
}

// GET /chat/rooms 응답 한 건. lastMessage는 메시지가 없으면 null.
export class RoomSummaryResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  buildingId: string;

  @ApiProperty()
  ownerId: string;

  @ApiProperty()
  tenantId: string;

  @ApiProperty({ type: LastMessageDto, nullable: true })
  lastMessage: LastMessageDto | null;
}
