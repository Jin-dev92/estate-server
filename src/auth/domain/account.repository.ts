import { Account } from './account.entity';
import { AuthProvider } from './auth-provider';

export const ACCOUNT_REPOSITORY = Symbol('ACCOUNT_REPOSITORY');

export interface AccountRepository {
  findByProvider(
    provider: AuthProvider,
    providerId: string,
  ): Promise<Account | null>;
  save(account: Account): Promise<Account>;
}
