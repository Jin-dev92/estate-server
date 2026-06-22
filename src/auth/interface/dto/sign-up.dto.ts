import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  MinLength,
} from 'class-validator';
import { Role } from '../../domain/role.enum';

export class SignUpDto {
  @ApiProperty({ example: 'owner@estate.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: '김철수' })
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: 'pw123456', minLength: 8 })
  @MinLength(8)
  password: string;

  // 자가 가입은 OWNER/TENANT만 허용. ADMIN 자가 부여 차단(보안).
  @ApiPropertyOptional({ enum: [Role.OWNER, Role.TENANT], example: Role.OWNER })
  @IsOptional()
  @IsIn([Role.OWNER, Role.TENANT])
  role?: Role;
}
