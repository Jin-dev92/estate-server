import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty } from 'class-validator';
import { Trim } from '../../../common/transform/trim.decorator';

export class LoginDto {
  @ApiProperty({ example: 'owner@estate.com' })
  @Trim()
  @IsEmail()
  email: string;

  @ApiProperty({ example: 'pw123456' })
  @IsNotEmpty()
  password: string;
}
