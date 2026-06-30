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

  async findById(id: string): Promise<User | null> {
    const row = await this.prisma.user.findFirst({
      where: { id, deletedAt: null },
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

  async update(user: User): Promise<User> {
    try {
      const row = await this.prisma.user.update({
        where: { id: user.id! },
        data: { name: user.name, passwordHash: user.passwordHash },
      });
      return User.reconstitute({
        id: row.id,
        email: row.email,
        name: row.name,
        passwordHash: row.passwordHash,
        role: row.role as Role,
      });
    } catch (e) {
      // findById와 update 사이에 대상이 삭제된 경우(P2025) → save의 P2002 변환과 동일하게 도메인 에러로.
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2025'
      ) {
        throw new AppException(AuthError.USER_NOT_FOUND);
      }
      throw e;
    }
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

  async saveWithAccount(
    user: User,
    link: { provider: string; providerId: string },
  ): Promise<User> {
    // nested write: User와 Account를 Prisma가 단일 트랜잭션으로 생성한다.
    // account 생성이 실패하면 user도 롤백되어 고아 레코드가 생기지 않는다.
    // 예외(P2002 등)는 호출부(use-case)에서 EMAIL_IN_USE로 변환하도록 전파한다.
    const row = await this.prisma.user.create({
      data: {
        email: user.email,
        name: user.name,
        passwordHash: user.passwordHash,
        role: user.role,
        accounts: {
          create: { provider: link.provider, providerId: link.providerId },
        },
      },
    });
    return User.reconstitute({
      id: row.id,
      email: row.email,
      name: row.name,
      passwordHash: row.passwordHash,
      role: row.role as Role,
    });
  }
}
