import { Logger } from '@nestjs/common';
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
      .fn<Promise<void>, [string, Date, TransactionClient?]>()
      .mockResolvedValue(undefined),
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
