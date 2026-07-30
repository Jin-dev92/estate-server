import { Inject, Injectable, Logger } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
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
      const message = `리프레시 토큰 재사용 탐지 — 가족 폐기. userId=${found.userId} familyId=${found.familyId} revoked=${revoked}`;
      this.logger.warn(message);
      // 스펙 §12: 재사용 탐지는 M10에서 "4xx는 Sentry 제외"로 정한 원칙의
      // 명시적 예외다 — 침해 신호라 운영 알림으로 올라가야 한다.
      // DSN 미설정 시 Sentry.init을 건너뛰므로(initSentry) 이 호출은 no-op이다.
      // 토큰 원문·해시는 넣지 않는다(userId·familyId·폐기 행 수만).
      Sentry.captureMessage(message, 'warning');
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
      // findByHash는 트랜잭션 밖이라 같은 토큰이 동시에 두 번 들어오면 둘 다
      // usedAt: null을 읽고 여기까지 온다. markUsed는 `usedAt: null`을
      // 조건으로 건 조건부 갱신(compare-and-set)이라, 먼저 커밋하는 쪽만
      // count=1로 성공한다. 진 쪽은 count=0을 받는데 — 이미 다른 요청이
      // 그 토큰을 소비했다는 뜻이므로 재사용으로 판정해 던진다.
      // throw는 트랜잭션 안이므로 롤백되어 이 요청은 새 토큰도 남기지 않는다.
      const updated = await this.refreshTokens.markUsed(found.id!, now, tx);
      if (updated === 0) {
        // 위쪽 isUsed() 분기(이미 커밋되어 확정된 재사용)와 성격이 다르다.
        // findByHash가 트랜잭션 밖이라 같은 토큰이 거의 동시에 두 번
        // 들어오면 둘 다 usedAt: null을 읽고 여기까지 온다 — 이 요청은
        // compare-and-set에서 진 쪽이므로 401로 거절하지만, 가족은
        // 폐기하지 않는다. 공격 경합인지 정상 클라이언트의 중복 제출
        // (네트워크 재시도·이중 클릭 등)인지 서버가 구분할 근거가 없어서다
        // (IP·User-Agent를 저장하지 않기로 한 결정 때문에 구분 단서도 없다).
        // 여기서 가족을 폐기하면 정상 사용자의 중복 제출을 공격으로 오인해
        // 전 기기를 로그아웃시키는 UX 회귀가 된다. 이 판단의 근거와 한계는
        // docs/superpowers/specs/2026-07-30-refresh-token-design.md §4.5·
        // §14를 참고. 로그만 남기고 Sentry는 캡처하지 않는다 — 정상 클라이언트의
        // 중복 제출로도 발생할 수 있어 노이즈가 될 수 있다고 판단했다.
        this.logger.warn(
          `리프레시 토큰 동시 제출 경합 — 이 요청 패배(가족 미폐기, 위쪽 재사용 탐지와 구분). userId=${found.userId} familyId=${found.familyId}`,
        );
        throw new AppException(AuthError.REFRESH_TOKEN_REUSED);
      }
      return this.issueSession.issue(
        { userId: user.id!, email: user.email, role: user.role },
        found.familyId,
        tx,
      );
    });
  }
}
