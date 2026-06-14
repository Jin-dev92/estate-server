import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class EnsureRoomDto {
  @ApiProperty({ description: '건물 ID' })
  @IsString()
  buildingId!: string;

  @ApiProperty({ description: '입주자(상대) 사용자 ID' })
  @IsString()
  tenantId!: string;
}
