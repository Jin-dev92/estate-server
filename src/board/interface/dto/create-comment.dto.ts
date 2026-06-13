import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty } from 'class-validator';

export class CreateCommentDto {
  @ApiProperty({ example: '확인했습니다. 감사합니다.' })
  @IsNotEmpty()
  content: string;
}
