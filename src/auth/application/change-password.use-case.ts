import { Inject, Injectable } from '@nestjs/common';
import { USER_REPOSITORY, UserRepository } from '../domain/user.repository';
import { PASSWORD_HASHER, PasswordHasher } from '../domain/password-hasher';
import { AppException } from '../../common/errors/app-exception';
import { AuthError } from '../auth.errors';
import {
  REFRESH_TOKEN_REPOSITORY,
  RefreshTokenRepository,
} from '../domain/refresh-token.repository';
import {
  TRANSACTION_RUNNER,
  TransactionRunner,
} from '../../outbox/domain/transaction-runner';

@Injectable()
export class ChangePasswordUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(REFRESH_TOKEN_REPOSITORY)
    private readonly refreshTokens: RefreshTokenRepository,
    @Inject(TRANSACTION_RUNNER) private readonly txRunner: TransactionRunner,
  ) {}

  async execute(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = await this.users.findById(userId);
    if (!user) throw new AppException(AuthError.USER_NOT_FOUND);
    // OAuth 가입 유저는 passwordHash가 null — 비밀번호 변경 불가.
    if (!user.passwordHash)
      throw new AppException(AuthError.INVALID_CREDENTIALS);
    const ok = await this.hasher.compare(currentPassword, user.passwordHash);
    if (!ok) throw new AppException(AuthError.INVALID_CREDENTIALS);
    const newHash = await this.hasher.hash(newPassword);

    // 해시 갱신과 세션 폐기를 한 트랜잭션으로 묶는다. 나누면 "비밀번호는
    // 바뀌었지만 기존 세션이 살아있는" 창이 생긴다.
    // 본인도 함께 튕긴다 — 비밀번호를 바꿨으니 다시 로그인하는 흐름이다.
    await this.txRunner.run(async (tx) => {
      await this.users.update(user.changePassword(newHash), tx);
      await this.refreshTokens.revokeAllByUser(userId, new Date(), tx);
    });
  }
}
