import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Post } from '../domain/post.entity';
import { PostCategory } from '../domain/post-category.enum';
import { PostRepository } from '../domain/post.repository';

@Injectable()
export class PrismaPostRepository implements PostRepository {
  constructor(private readonly prisma: PrismaService) {}

  private toDomain(row: {
    id: string;
    buildingId: string;
    authorId: string;
    category: string;
    title: string;
    content: string;
  }): Post {
    return Post.reconstitute({
      id: row.id,
      buildingId: row.buildingId,
      authorId: row.authorId,
      category: row.category as PostCategory,
      title: row.title,
      content: row.content,
    });
  }

  async create(post: Post): Promise<Post> {
    const row = await this.prisma.post.create({
      data: {
        buildingId: post.buildingId,
        authorId: post.authorId,
        category: post.category,
        title: post.title,
        content: post.content,
      },
    });
    return this.toDomain(row);
  }

  async findById(id: string): Promise<Post | null> {
    const row = await this.prisma.post.findUnique({ where: { id } });
    return row ? this.toDomain(row) : null;
  }

  async findByBuilding(buildingId: string): Promise<Post[]> {
    const rows = await this.prisma.post.findMany({
      where: { buildingId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => this.toDomain(row));
  }

  async update(post: Post): Promise<Post> {
    const row = await this.prisma.post.update({
      where: { id: post.id! },
      data: { title: post.title, content: post.content },
    });
    return this.toDomain(row);
  }

  async delete(id: string): Promise<void> {
    await this.prisma.post.delete({ where: { id } });
  }
}
