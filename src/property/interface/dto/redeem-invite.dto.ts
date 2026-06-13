import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty } from 'class-validator';

export class RedeemInviteDto {
  @ApiProperty({ example: 'A1B2C3D4' })
  @IsNotEmpty()
  code: string;
}
