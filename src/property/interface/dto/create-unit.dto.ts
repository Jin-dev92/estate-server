import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsNotEmpty } from 'class-validator';
import { Trim } from '../../../common/transform/trim.decorator';

export class CreateUnitDto {
  @ApiProperty({ example: '101호' })
  @Trim()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: 1 })
  @IsInt()
  floor: number;
}
