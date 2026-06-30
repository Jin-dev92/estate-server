import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, IsNotEmpty } from 'class-validator';
import { Role } from '../../domain/role.enum';

export class KakaoLoginDto {
  @ApiProperty() @IsString() @IsNotEmpty() code: string;
  @ApiProperty() @IsString() @IsNotEmpty() redirectUri: string;
}

export class CompleteKakaoDto {
  @ApiProperty() @IsString() @IsNotEmpty() onboardingToken: string;
  @ApiProperty({ enum: Role, enumName: 'Role' })
  @IsIn([Role.OWNER, Role.TENANT])
  role: Role;
}
