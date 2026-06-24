import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, MinLength } from 'class-validator';
import { Role } from '../../domain/role.enum';

export class UpdateProfileDto {
  @ApiProperty({ example: '김철수' })
  @IsNotEmpty()
  name: string;
}

export class ChangePasswordDto {
  @ApiProperty()
  @IsNotEmpty()
  currentPassword: string;

  @ApiProperty({ minLength: 8 })
  @MinLength(8)
  newPassword: string;
}

export class ProfileResponseDto {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'a@b.com' }) email: string;
  @ApiProperty({ example: '김철수' }) name: string;
  @ApiProperty({ enum: Role, enumName: 'Role' }) role: Role;
}
