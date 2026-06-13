import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsOptional } from 'class-validator';
import { PostCategory } from '../../domain/post-category.enum';

export class CreatePostDto {
  @ApiProperty({
    enum: PostCategory, // 허용값 NOTICE|FREE 를 UI에 노출
    enumName: 'PostCategory', // 재사용 명명 스키마(#/components/schemas/PostCategory)로 분리
    required: false,
    example: PostCategory.FREE,
  })
  @IsOptional()
  @IsEnum(PostCategory)
  category?: PostCategory;

  @ApiProperty({ example: '공지: 단수 안내' })
  @IsNotEmpty()
  title: string;

  @ApiProperty({ example: '내일 10시~12시 단수됩니다.' })
  @IsNotEmpty()
  content: string;
}
