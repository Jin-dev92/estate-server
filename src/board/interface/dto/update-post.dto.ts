import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty } from 'class-validator';
import { Trim } from '../../../common/transform/trim.decorator';

export class UpdatePostDto {
  @ApiProperty({ example: '공지: 단수 안내(수정)' })
  @Trim()
  @IsNotEmpty()
  title: string;

  @ApiProperty({ example: '단수 시간이 11시~13시로 변경되었습니다.' })
  @IsNotEmpty()
  content: string;
}
