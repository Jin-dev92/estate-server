import { Logger } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { AppException } from '../../common/errors/app-exception';
import {
  TransactionClient,
  TransactionRunner,
} from '../../outbox/domain/transaction-runner';
import { RefreshToken } from '../domain/refresh-token.entity';
import { RefreshTokenGenerator } from '../domain/refresh-token-generator';
import { RefreshTokenRepository } from '../domain/refresh-token.repository';
import { Role } from '../domain/role.enum';
import { User } from '../domain/user.entity';
import { UserRepository } from '../domain/user.repository';
import { IssueSessionService, TokenPair } from './issue-session.service';
import { RefreshTokensUseCase } from './refresh-tokens.use-case';

// 재사용 탐지는 Sentry로도 알린다 — 코드베이스 관례대로 모듈 자동 모킹.
jest.mock('@sentry/nestjs');

const USER_ID = 'user-1';
const EMAIL = 'tenant@example.com';
const FAMILY_ID = 'family-1';
const TOKEN_ID = 'token-1';
const RAW_TOKEN = 'raw-token';
const TOKEN_HASH = 'token-hash';
const NEW_PAIR = { accessToken: 'new-access', refreshToken: 'new-refresh' };
const FUTURE = new Date(Date.now() + 60_000);
const PAST = new Date(Date.now() - 60_000);

function persisted(overrides?: {
  usedAt?: Date | null;
  revokedAt?: Date | null;
  expiresAt?: Date;
}): RefreshToken {
  return RefreshToken.reconstitute({
    id: TOKEN_ID,
    userId: USER_ID,
    tokenHash: TOKEN_HASH,
    familyId: FAMILY_ID,
    expiresAt: overrides?.expiresAt ?? FUTURE,
    usedAt: overrides?.usedAt ?? null,
    revokedAt: overrides?.revokedAt ?? null,
  });
}

function setup(found: RefreshToken | null, options?: { userFound?: boolean }) {
  const repo = {
    findByHash: jest
      .fn<Promise<RefreshToken | null>, [string]>()
      .mockResolvedValue(found),
    markUsed: jest
      .fn<Promise<number>, [string, Date, TransactionClient?]>()
      .mockResolvedValue(1),
    revokeFamily: jest
      .fn<Promise<number>, [string, Date, TransactionClient?]>()
      .mockResolvedValue(2),
  } satisfies Partial<jest.Mocked<RefreshTokenRepository>>;

  const generator = {
    hash: jest.fn<string, [string]>().mockReturnValue(TOKEN_HASH),
    generate: jest.fn<{ token: string; tokenHash: string }, []>(),
  } satisfies Partial<jest.Mocked<RefreshTokenGenerator>>;

  const userFound = options?.userFound ?? true;
  const users = {
    findById: jest.fn<Promise<User | null>, [string]>().mockResolvedValue(
      userFound
        ? User.reconstitute({
            id: USER_ID,
            email: EMAIL,
            name: '입주자',
            passwordHash: 'hash',
            role: Role.TENANT,
          })
        : null,
    ),
  } satisfies Partial<jest.Mocked<UserRepository>>;

  const issueSession = {
    issue: jest
      .fn<
        Promise<TokenPair>,
        [
          { userId: string; email: string; role: Role },
          string?,
          TransactionClient?,
        ]
      >()
      .mockResolvedValue(NEW_PAIR),
  } satisfies Partial<jest.Mocked<IssueSessionService>>;

  // 트랜잭션 러너는 콜백을 그대로 실행한다(단위 테스트에서는 실제 tx 불필요).
  // run<T>은 제네릭이라 satisfies로 TransactionRunner와 구조적으로 맞추면
  // TokenPair 전용 mock과 충돌한다(T가 TokenPair로 좁혀짐) — 그래서
  // 여기만 satisfies 없이 두고, 생성자에 넘길 때 단언으로 좁힌다.
  const txRunner = {
    run: jest
      .fn<Promise<TokenPair>, [(tx: TransactionClient) => Promise<TokenPair>]>()
      .mockImplementation((fn) => fn({} as never)),
  };

  const useCase = new RefreshTokensUseCase(
    repo as unknown as RefreshTokenRepository,
    generator,
    users as unknown as UserRepository,
    issueSession as unknown as IssueSessionService,
    txRunner as unknown as TransactionRunner,
  );

  return { useCase, repo, issueSession, txRunner };
}

describe('RefreshTokensUseCase', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('when the token is usable', () => {
    it('should consume the old token and issue a new pair', async () => {
      const { useCase, repo } = setup(persisted());

      const pair = await useCase.execute(RAW_TOKEN);

      expect(pair).toEqual(NEW_PAIR);
      expect(repo.markUsed).toHaveBeenCalledWith(
        TOKEN_ID,
        expect.any(Date),
        expect.anything(),
      );
    });

    it('should keep the same familyId so the session continues', async () => {
      const { useCase, issueSession } = setup(persisted());

      await useCase.execute(RAW_TOKEN);

      expect(issueSession.issue).toHaveBeenCalledWith(
        { userId: USER_ID, email: EMAIL, role: Role.TENANT },
        FAMILY_ID,
        expect.anything(),
      );
    });

    it('should perform consume and issue inside one transaction', async () => {
      const { useCase, txRunner } = setup(persisted());

      await useCase.execute(RAW_TOKEN);

      expect(txRunner.run).toHaveBeenCalledTimes(1);
    });

    // 스펙 §11-6(회전 원자성). 실제 DB 롤백은 Prisma가 담당하므로 단위
    // 테스트로는 확인할 수 없다. 여기서 검증하는 것은 "새 토큰 발급 실패가
    // 트랜잭션 콜백 밖으로 전파되는가"다 — 전파되지 않으면 러너가 커밋해
    // 소비 처리만 남는다.
    it('should propagate a failure from issuing so the transaction rolls back', async () => {
      const { useCase, issueSession } = setup(persisted());
      const failure = new Error('insert failed');
      issueSession.issue.mockRejectedValue(failure);
      expect.assertions(1);

      await expect(useCase.execute(RAW_TOKEN)).rejects.toThrow(failure);
    });

    // 스펙 §11-15(회전 후 current 유지). 이 유스케이스는 기존 familyId를
    // 그대로 넘기는 것까지 책임진다. 그 familyId가 액세스 토큰의 fam으로
    // 들어가는 것은 IssueSessionService 테스트가 검증한다(Task 8).
    it('should not create a new family on rotation', async () => {
      const { useCase, issueSession } = setup(persisted());

      await useCase.execute(RAW_TOKEN);

      const passedFamilyId = issueSession.issue.mock.calls[0][1];
      expect(passedFamilyId).toBe(FAMILY_ID);
    });

    // markUsed에 넘겨야 할 시각과 발급을 감싸는 tx가 실제로 트랜잭션
    // 콜백 인자(tx)와 같은 객체인지 확인한다. 다른 객체를 넘기면 markUsed가
    // 트랜잭션 밖에서 실행되는 버그가 생겨도 "run이 1번 호출됐다"는
    // 통과해버린다.
    it('should pass the transaction client from the runner callback into markUsed and issue', async () => {
      const { useCase, repo, issueSession, txRunner } = setup(persisted());
      const TX_MARKER = { marker: 'tx' } as unknown as TransactionClient;
      txRunner.run.mockImplementation((fn) => fn(TX_MARKER));

      await useCase.execute(RAW_TOKEN);

      expect(repo.markUsed).toHaveBeenCalledWith(
        TOKEN_ID,
        expect.any(Date),
        TX_MARKER,
      );
      expect(issueSession.issue).toHaveBeenCalledWith(
        expect.anything(),
        FAMILY_ID,
        TX_MARKER,
      );
    });
  });

  describe('when the token was already consumed', () => {
    it('should revoke the whole family and throw REFRESH_TOKEN_REUSED', async () => {
      const { useCase, repo } = setup(persisted({ usedAt: new Date() }));
      expect.assertions(3);

      try {
        await useCase.execute(RAW_TOKEN);
      } catch (e) {
        const error = e as AppException;
        expect(error).toBeInstanceOf(AppException);
        expect(error.code).toBe('AUTH_REFRESH_TOKEN_REUSED');
      }

      expect(repo.revokeFamily).toHaveBeenCalledWith(
        FAMILY_ID,
        expect.any(Date),
      );
    });

    // I-1: 스펙 §12 — 재사용 탐지는 M10의 "4xx는 Sentry 제외" 원칙의
    // 명시적 예외다. 토큰 원문·해시는 Sentry 메시지에 들어가면 안 된다.
    // 리뷰 반영: 메시지 문자열에 userId·familyId를 넣으면 이벤트마다 메시지가
    // 달라져 Sentry 그룹핑이 깨진다 — 고정 메시지 + scope 콜백으로 구조화
    // 컨텍스트를 싣는지 검증한다.
    it('should capture a fixed Sentry message with structured user/tag context but no token material', async () => {
      const { useCase } = setup(persisted({ usedAt: new Date() }));
      expect.assertions(5);

      try {
        await useCase.execute(RAW_TOKEN);
      } catch {
        // 재사용 예외는 별도 케이스에서 검증한다.
      }

      const [message, captureContext] = jest.mocked(Sentry.captureMessage).mock
        .calls[0];
      expect(message).toBe('refresh token reuse detected');
      expect(message).not.toContain(RAW_TOKEN);

      const setLevel = jest.fn<Sentry.Scope, [Sentry.SeverityLevel]>();
      const setUser = jest.fn<Sentry.Scope, [Sentry.User | null]>();
      const setTag = jest.fn<Sentry.Scope, [string, unknown]>();
      const scope = { setLevel, setUser, setTag } as unknown as Sentry.Scope;
      (captureContext as (scope: Sentry.Scope) => Sentry.Scope)(scope);

      expect(setUser).toHaveBeenCalledWith({ id: USER_ID });
      expect(setTag).toHaveBeenCalledWith('familyId', FAMILY_ID);
      expect(setLevel).toHaveBeenCalledWith('warning');
    });

    // 재사용 탐지 경로는 회전(markUsed·issue)을 절대 수행하면 안 된다.
    // 조건 순서를 바꿔 isUsed() 체크를 isUsable() 뒤로 옮기는 뮤테이션이
    // 들어와도, 이 단정이 없으면 "가족은 폐기됐지만 회전도 같이 일어났다"는
    // 상태를 못 잡는다.
    it('should not consume the token or issue a new pair', async () => {
      const { useCase, repo, issueSession } = setup(
        persisted({ usedAt: new Date() }),
      );
      expect.assertions(3);

      await expect(useCase.execute(RAW_TOKEN)).rejects.toThrow(AppException);
      expect(repo.markUsed).not.toHaveBeenCalled();
      expect(issueSession.issue).not.toHaveBeenCalled();
    });
  });

  // I-3: findByHash는 트랜잭션 밖이라 같은 토큰이 동시에 두 번 들어오면
  // 둘 다 usedAt: null을 읽고 여기까지 온다. markUsed(compare-and-set)는
  // 먼저 커밋한 쪽만 count=1이고 진 쪽은 count=0을 받는다 — 그 상태를
  // 재현한다(레포지토리 mock이 count=0을 돌려주는 것으로 시뮬레이션).
  describe('when markUsed loses the compare-and-set race (concurrent submission)', () => {
    it('should throw REFRESH_TOKEN_REUSED and not issue a new pair', async () => {
      const { useCase, repo, issueSession } = setup(persisted());
      repo.markUsed.mockResolvedValue(0);
      expect.assertions(3);

      try {
        await useCase.execute(RAW_TOKEN);
      } catch (e) {
        const error = e as AppException;
        expect(error).toBeInstanceOf(AppException);
        expect(error.code).toBe('AUTH_REFRESH_TOKEN_REUSED');
      }

      expect(issueSession.issue).not.toHaveBeenCalled();
    });

    // 재리뷰 지적: 이 경로가 무음이었다 — 바로 위 isUsed() 분기(확정된
    // 재사용)는 logger.warn + Sentry를 남기는데 경합 패배 경로만 로그가
    // 없어서, 경합이 실제로 얼마나 발생하는지 관측할 수단이 없었다.
    // Sentry는 의도적으로 캡처하지 않는다 — 정상 클라이언트의 중복 제출로도
    // 발생할 수 있어 노이즈가 될 수 있다고 판단했다(보고서 참고).
    it('should log a warning with userId/familyId but no token material, and not capture Sentry', async () => {
      const { useCase, repo } = setup(persisted());
      repo.markUsed.mockResolvedValue(0);
      const warnSpy = jest.spyOn(Logger.prototype, 'warn');
      expect.assertions(3);

      try {
        await useCase.execute(RAW_TOKEN);
      } catch {
        // 예외 자체는 위 케이스에서 검증한다.
      }

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(
          new RegExp(`userId=${USER_ID}.*familyId=${FAMILY_ID}`),
        ),
      );
      const message = warnSpy.mock.calls[0][0] as string;
      expect(message).not.toContain(RAW_TOKEN);
      expect(Sentry.captureMessage).not.toHaveBeenCalled();
    });
  });

  describe('when the token is expired', () => {
    it('should throw INVALID_REFRESH_TOKEN without revoking the family', async () => {
      const { useCase, repo } = setup(persisted({ expiresAt: PAST }));
      expect.assertions(2);

      try {
        await useCase.execute(RAW_TOKEN);
      } catch (e) {
        expect((e as AppException).code).toBe('AUTH_INVALID_REFRESH_TOKEN');
      }

      expect(repo.revokeFamily).not.toHaveBeenCalled();
    });
  });

  describe('when the token is revoked', () => {
    it('should throw INVALID_REFRESH_TOKEN without revoking again', async () => {
      const { useCase, repo } = setup(persisted({ revokedAt: new Date() }));
      expect.assertions(2);

      try {
        await useCase.execute(RAW_TOKEN);
      } catch (e) {
        expect((e as AppException).code).toBe('AUTH_INVALID_REFRESH_TOKEN');
      }

      expect(repo.revokeFamily).not.toHaveBeenCalled();
    });
  });

  describe('when no token row matches', () => {
    it('should throw INVALID_REFRESH_TOKEN and change nothing', async () => {
      const { useCase, repo } = setup(null);
      expect.assertions(3);

      try {
        await useCase.execute(RAW_TOKEN);
      } catch (e) {
        expect((e as AppException).code).toBe('AUTH_INVALID_REFRESH_TOKEN');
      }

      expect(repo.markUsed).not.toHaveBeenCalled();
      expect(repo.revokeFamily).not.toHaveBeenCalled();
    });
  });

  // usedAt·revokedAt·expiresAt이 전부 정상이어도 유저가 삭제/탈퇴 등으로
  // 사라졌다면 회전을 진행하면 안 된다. 이 가드(`if (!user) throw`)가
  // 뮤테이션으로 삭제돼도 다른 테스트는 잡지 못한다 — setup()이 항상
  // 유저를 찾도록 만들기 때문이다.
  describe('when the token is valid but the user no longer exists', () => {
    it('should throw INVALID_REFRESH_TOKEN without consuming the token', async () => {
      const { useCase, repo, issueSession } = setup(persisted(), {
        userFound: false,
      });
      expect.assertions(3);

      try {
        await useCase.execute(RAW_TOKEN);
      } catch (e) {
        expect((e as AppException).code).toBe('AUTH_INVALID_REFRESH_TOKEN');
      }

      expect(repo.markUsed).not.toHaveBeenCalled();
      expect(issueSession.issue).not.toHaveBeenCalled();
    });
  });
});
