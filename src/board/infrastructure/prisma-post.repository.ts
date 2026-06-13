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
    // deletedAt: null 조건을 붙이려면 unique 전용 findUnique 대신 findFirst를 쓴다.
    const row = await this.prisma.post.findFirst({
      where: { id, deletedAt: null },
    });
    return row ? this.toDomain(row) : null;
  }

  async findByBuilding(buildingId: string): Promise<Post[]> {
    const rows = await this.prisma.post.findMany({
      where: { buildingId, deletedAt: null },
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
    // 물리삭제 대신 논리삭제. Post와 그에 속한 살아있는 Comment를
    // 같은 트랜잭션에서 함께 soft delete해 원자성을 보장한다.
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.comment.updateMany({
        where: { postId: id, deletedAt: null },
        data: { deletedAt: now },
      }),
      this.prisma.post.update({
        where: { id },
        data: { deletedAt: now },
      }),
    ]);
  }
}
