import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { User } from '../domain/user.entity';
import { Role } from '../domain/role.enum';
import { UserRepository } from '../domain/user.repository';
import { AppException } from '../../common/errors/app-exception';
import { AuthError } from '../auth.errors';

@Injectable()
export class PrismaUserRepository implements UserRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByEmail(email: string): Promise<User | null> {
    // deletedAt: null 조건을 붙이려면 findUnique 대신 findFirst를 쓴다.
    const row = await this.prisma.user.findFirst({
      where: { email, deletedAt: null },
    });
    if (!row) return null;
    return User.reconstitute({
      id: row.id,
      email: row.email,
      name: row.name,
      passwordHash: row.passwordHash,
      role: row.role as Role,
    });
  }

  async save(user: User): Promise<User> {
    try {
      const row = await this.prisma.user.create({
        data: {
          email: user.email,
          name: user.name,
          passwordHash: user.passwordHash,
          role: user.role,
        },
      });
      return User.reconstitute({
        id: row.id,
        email: row.email,
        name: row.name,
        passwordHash: row.passwordHash,
        role: row.role as Role,
      });
    } catch (e) {
      // 동시 가입 TOCTOU: findByEmail 통과 후 unique(email) 제약에 걸리는 경우
      // P2002를 409로 변환해 사전 중복 체크와 같은 응답을 보장한다.
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new AppException(AuthError.EMAIL_IN_USE);
      }
      throw e;
    }
  }
}
