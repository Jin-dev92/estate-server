import { ApiProperty } from '@nestjs/swagger';

// M2.5 에러 봉투(ErrorResponse)의 Swagger 문서용 표현. 4xx/5xx @ApiResponse에서 참조.
export class ErrorResponseDto {
  @ApiProperty({ example: 404 })
  statusCode: number;

  @ApiProperty({
    example: 'BOARD_POST_NOT_FOUND',
    description: 'FE 분기 기준 안정 코드',
  })
  code: string;

  @ApiProperty({ example: '게시글을 찾을 수 없습니다.' })
  message: string;

  @ApiProperty({ example: '/posts/abc123' })
  path: string;

  @ApiProperty({ example: '2026-06-13T08:00:00.000Z' })
  timestamp: string;
}
