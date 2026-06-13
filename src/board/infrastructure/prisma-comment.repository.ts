import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Comment } from '../domain/comment.entity';
import { CommentRepository } from '../domain/comment.repository';

@Injectable()
export class PrismaCommentRepository implements CommentRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(comment: Comment): Promise<Comment> {
    const row = await this.prisma.comment.create({
      data: {
        postId: comment.postId,
        authorId: comment.authorId,
        content: comment.content,
      },
    });
    return Comment.reconstitute({
      id: row.id,
      postId: row.postId,
      authorId: row.authorId,
      content: row.content,
    });
  }

  async findByPost(postId: string): Promise<Comment[]> {
    const rows = await this.prisma.comment.findMany({
      where: { postId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) =>
      Comment.reconstitute({
        id: row.id,
        postId: row.postId,
        authorId: row.authorId,
        content: row.content,
      }),
    );
  }
}
