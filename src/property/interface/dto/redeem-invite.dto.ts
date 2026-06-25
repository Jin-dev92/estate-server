import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty } from 'class-validator';
import { Trim } from '../../../common/transform/trim.decorator';

export class RedeemInviteDto {
  @ApiProperty({ example: 'A1B2C3D4' })
  @Trim()
  @IsNotEmpty()
  code: string;
}
