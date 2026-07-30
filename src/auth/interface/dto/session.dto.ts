import { ApiProperty } from '@nestjs/swagger';

export class SessionResponseDto {
  @ApiProperty({ description: '세션(리프레시 토큰 가족) 식별자' })
  familyId: string;

  @ApiProperty({ description: '이 세션이 시작된 시각(= 로그인 시각)' })
  createdAt: Date;

  @ApiProperty({
    description: '이 요청을 보낸 세션인지 여부',
  })
  current: boolean;
}
