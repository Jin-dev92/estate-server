import { ChangePasswordUseCase } from './change-password.use-case';
import { UserRepository } from '../domain/user.repository';
import { PasswordHasher } from '../domain/password-hasher';
import { RefreshTokenRepository } from '../domain/refresh-token.repository';
import {
  TransactionClient,
  TransactionRunner,
} from '../../outbox/domain/transaction-runner';
import { User } from '../domain/user.entity';
import { Role } from '../domain/role.enum';

const USER_ID = 'u1';
const CURRENT_PASSWORD = 'current';
const NEW_PASSWORD = 'newpass12';
const OLD_HASH = 'OLD_HASH';
const NEW_HASH = 'NEW_HASH';

function user(passwordHash: string | null = OLD_HASH): User {
  return User.reconstitute({
    id: USER_ID,
    email: 'a@b.com',
    name: '김철수',
    passwordHash,
    role: Role.TENANT,
  });
}

// compareResult: 현재 비밀번호 일치 여부. foundUser: findById 결과(기본값은 정상 유저).
function setup(options?: { compareResult?: boolean; foundUser?: User | null }) {
  const compareResult = options?.compareResult ?? true;
  const foundUser =
    options?.foundUser === undefined ? user() : options.foundUser;

  const users = {
    findById: jest
      .fn<Promise<User | null>, [string]>()
      .mockResolvedValue(foundUser),
    update: jest
      .fn<Promise<User>, [User, TransactionClient?]>()
      .mockImplementation((u) => Promise.resolve(u)),
  } satisfies Partial<jest.Mocked<UserRepository>>;

  const hasher = {
    compare: jest
      .fn<Promise<boolean>, [string, string]>()
      .mockResolvedValue(compareResult),
    hash: jest.fn<Promise<string>, [string]>().mockResolvedValue(NEW_HASH),
  } satisfies Partial<jest.Mocked<PasswordHasher>>;

  const refreshTokens = {
    revokeAllByUser: jest
      .fn<Promise<number>, [string, Date, TransactionClient?]>()
      .mockResolvedValue(2),
  } satisfies Partial<jest.Mocked<RefreshTokenRepository>>;

  // 트랜잭션 러너는 콜백을 그대로 실행한다(단위 테스트에서는 실제 tx 불필요).
  const txRunner = {
    run: jest
      .fn<Promise<void>, [(tx: TransactionClient) => Promise<void>]>()
      .mockImplementation((fn) => fn({} as never)),
  };

  const useCase = new ChangePasswordUseCase(
    users as unknown as UserRepository,
    hasher,
    refreshTokens as unknown as RefreshTokenRepository,
    txRunner as unknown as TransactionRunner,
  );

  return { useCase, users, hasher, refreshTokens, txRunner };
}

describe('ChangePasswordUseCase', () => {
  afterEach(() => jest.clearAllMocks());

  describe('현재 비밀번호가 맞을 때', () => {
    it('새 해시로 update한다', async () => {
      const { useCase, users } = setup();

      await useCase.execute(USER_ID, CURRENT_PASSWORD, NEW_PASSWORD);

      expect(users.update).toHaveBeenCalledWith(
        expect.objectContaining({ passwordHash: NEW_HASH }),
        expect.anything(),
      );
    });

    it('should revoke every session so the leaked password cannot be reused', async () => {
      const { useCase, refreshTokens } = setup();

      await useCase.execute(USER_ID, CURRENT_PASSWORD, NEW_PASSWORD);

      // revokeFamily(부분 폐기)가 아니라 revokeAllByUser(전체 폐기)로,
      // 정확한 userId를 넘겨야 한다 — 다른 유저의 세션을 끊으면 안 된다.
      expect(refreshTokens.revokeAllByUser).toHaveBeenCalledWith(
        USER_ID,
        expect.any(Date),
        expect.anything(),
      );
    });

    it('should update the hash and revoke sessions in one transaction', async () => {
      const { useCase, txRunner } = setup();

      await useCase.execute(USER_ID, CURRENT_PASSWORD, NEW_PASSWORD);

      expect(txRunner.run).toHaveBeenCalledTimes(1);
    });

    // txRunner.run이 1번 호출된 것만으로는 users.update와
    // revokeAllByUser가 실제로 그 콜백 "안에서" 같은 tx로 실행됐는지
    // 보장하지 못한다 — 둘 다 콜백 밖에서 별도로 호출돼도 run은 1번
    // 호출될 수 있다. 콜백이 넘긴 tx 객체가 두 호출에 동일하게
    // 전달됐는지까지 직접 확인한다.
    it('should pass the same transaction client from the runner callback into update and revokeAllByUser', async () => {
      const { useCase, users, refreshTokens, txRunner } = setup();
      const TX_MARKER = { marker: 'tx' } as unknown as TransactionClient;
      txRunner.run.mockImplementation((fn) => fn(TX_MARKER));

      await useCase.execute(USER_ID, CURRENT_PASSWORD, NEW_PASSWORD);

      expect(users.update).toHaveBeenCalledWith(expect.anything(), TX_MARKER);
      expect(refreshTokens.revokeAllByUser).toHaveBeenCalledWith(
        USER_ID,
        expect.any(Date),
        TX_MARKER,
      );
    });
  });

  describe('현재 비밀번호가 틀렸을 때', () => {
    it('INVALID_CREDENTIALS를 던지고 update·폐기 둘 다 하지 않는다', async () => {
      const { useCase, users, refreshTokens } = setup({
        compareResult: false,
      });
      expect.assertions(3);

      await expect(
        useCase.execute(USER_ID, 'wrong', NEW_PASSWORD),
      ).rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' });

      expect(users.update).not.toHaveBeenCalled();
      // 잘못된 요청으로 남의(혹은 본인의 잘못된 시도로) 세션을 끊을 수
      // 있으면 안 된다 — 실패 경로에서는 폐기가 아예 호출되지 않아야 한다.
      expect(refreshTokens.revokeAllByUser).not.toHaveBeenCalled();
    });
  });

  describe('사용자가 없을 때', () => {
    it('USER_NOT_FOUND를 던지고 폐기하지 않는다', async () => {
      const { useCase, refreshTokens } = setup({ foundUser: null });
      expect.assertions(2);

      await expect(
        useCase.execute(USER_ID, CURRENT_PASSWORD, NEW_PASSWORD),
      ).rejects.toMatchObject({ code: 'AUTH_USER_NOT_FOUND' });

      expect(refreshTokens.revokeAllByUser).not.toHaveBeenCalled();
    });
  });

  describe('OAuth 가입 유저일 때(passwordHash가 null)', () => {
    it('INVALID_CREDENTIALS를 던지고 폐기하지 않는다', async () => {
      const { useCase, refreshTokens } = setup({ foundUser: user(null) });
      expect.assertions(2);

      await expect(
        useCase.execute(USER_ID, CURRENT_PASSWORD, NEW_PASSWORD),
      ).rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' });

      expect(refreshTokens.revokeAllByUser).not.toHaveBeenCalled();
    });
  });
});
