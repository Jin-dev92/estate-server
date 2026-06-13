import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty } from 'class-validator';

export class UpdatePostDto {
  @ApiProperty({ example: '공지: 단수 안내(수정)' })
  @IsNotEmpty()
  title: string;

  @ApiProperty({ example: '단수 시간이 11시~13시로 변경되었습니다.' })
  @IsNotEmpty()
  content: string;
}
