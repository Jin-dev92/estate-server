import { IsEnum, IsNotEmpty, IsOptional } from 'class-validator';
import { PostCategory } from '../../domain/post-category.enum';

export class CreatePostDto {
  @IsOptional()
  @IsEnum(PostCategory)
  category?: PostCategory;

  @IsNotEmpty()
  title: string;

  @IsNotEmpty()
  content: string;
}
