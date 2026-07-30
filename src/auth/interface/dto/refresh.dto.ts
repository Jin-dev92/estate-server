import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class RefreshTokenDto {
  @ApiProperty({
    description: '발급받은 리프레시 토큰',
    example: 'YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo',
  })
  @IsString()
  @IsNotEmpty()
  refreshToken: string;
}

export class TokenPairResponseDto {
  @ApiProperty({ description: '액세스 토큰(JWT). 기본 수명 15분' })
  accessToken: string;

  @ApiProperty({
    description: '리프레시 토큰. 갱신할 때마다 새 값으로 교체된다(회전)',
  })
  refreshToken: string;
}
