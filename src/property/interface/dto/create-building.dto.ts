import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty } from 'class-validator';
import { Trim } from '../../../common/transform/trim.decorator';

export class CreateBuildingDto {
  @ApiProperty({ example: '래미안 아파트' })
  @Trim()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: '서울시 강남구 테헤란로 1' })
  @Trim()
  @IsNotEmpty()
  address: string;
}
