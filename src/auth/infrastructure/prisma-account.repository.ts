import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Account } from '../domain/account.entity';
import { AccountRepository } from '../domain/account.repository';
import { AuthProvider } from '../domain/auth-provider';

@Injectable()
export class PrismaAccountRepository implements AccountRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByProvider(
    provider: AuthProvider,
    providerId: string,
  ): Promise<Account | null> {
    const row = await this.prisma.account.findUnique({
      where: { provider_providerId: { provider, providerId } },
    });
    if (!row) return null;
    return Account.reconstitute({
      id: row.id,
      userId: row.userId,
      provider: row.provider as AuthProvider,
      providerId: row.providerId,
    });
  }

  async save(account: Account): Promise<Account> {
    const row = await this.prisma.account.create({
      data: {
        userId: account.userId,
        provider: account.provider,
        providerId: account.providerId,
      },
    });
    return Account.reconstitute({
      id: row.id,
      userId: row.userId,
      provider: row.provider as AuthProvider,
      providerId: row.providerId,
    });
  }
}
