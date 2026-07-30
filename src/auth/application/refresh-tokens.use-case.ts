import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/errors/app-exception';
import {
  TRANSACTION_RUNNER,
  TransactionRunner,
} from '../../outbox/domain/transaction-runner';
import { AuthError } from '../auth.errors';
import {
  REFRESH_TOKEN_GENERATOR,
  RefreshTokenGenerator,
} from '../domain/refresh-token-generator';
import {
  REFRESH_TOKEN_REPOSITORY,
  RefreshTokenRepository,
} from '../domain/refresh-token.repository';
import { USER_REPOSITORY, UserRepository } from '../domain/user.repository';
import { IssueSessionService, TokenPair } from './issue-session.service';

@Injectable()
export class RefreshTokensUseCase {
  private readonly logger = new Logger(RefreshTokensUseCase.name);

  constructor(
    @Inject(REFRESH_TOKEN_REPOSITORY)
    private readonly refreshTokens: RefreshTokenRepository,
    @Inject(REFRESH_TOKEN_GENERATOR)
    private readonly generator: RefreshTokenGenerator,
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    private readonly issueSession: IssueSessionService,
    @Inject(TRANSACTION_RUNNER) private readonly txRunner: TransactionRunner,
  ) {}

  async execute(refreshToken: string): Promise<TokenPair> {
    const now = new Date();
    const found = await this.refreshTokens.findByHash(
      this.generator.hash(refreshToken),
    );

    if (!found) throw new AppException(AuthError.INVALID_REFRESH_TOKEN);

    // 이미 소비된 토큰의 재제출 = 사본 존재 = 침해 신호.
    // 정상 클라이언트는 회전으로 교체된 토큰을 다시 쓸 이유가 없다.
    // 대응은 가족 전체 폐기다 — 누가 진짜 사용자인지 서버가 구분할 수
    // 없으므로 둘 다 끊고 재인증을 요구하는 편이 안전하다.
    if (found.isUsed()) {
      const revoked = await this.refreshTokens.revokeFamily(
        found.familyId,
        now,
      );
      this.logger.warn(
        `리프레시 토큰 재사용 탐지 — 가족 폐기. userId=${found.userId} familyId=${found.familyId} revoked=${revoked}`,
      );
      throw new AppException(AuthError.REFRESH_TOKEN_REUSED);
    }

    // 만료·폐기는 침해가 아니므로 가족을 폐기하지 않는다.
    // 여기서 폐기하면 "만료 토큰을 늦게 제출했다는 이유로 다른 기기까지
    // 끊기는" 오작동이 된다.
    if (!found.isUsable(now)) {
      throw new AppException(AuthError.INVALID_REFRESH_TOKEN);
    }

    const user = await this.users.findById(found.userId);
    if (!user) throw new AppException(AuthError.INVALID_REFRESH_TOKEN);

    // 소비 처리와 새 발급을 한 트랜잭션으로 묶는다. 나누면 "기존 토큰은
    // 소비됐는데 새 토큰이 없는" 상태가 가능해져 사용자가 튕긴다.
    return this.txRunner.run(async (tx) => {
      await this.refreshTokens.markUsed(found.id!, now, tx);
      return this.issueSession.issue(
        { userId: user.id!, email: user.email, role: user.role },
        found.familyId,
        tx,
      );
    });
  }
}
