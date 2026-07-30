import { LoginUseCase } from './login.use-case';
import { User } from '../domain/user.entity';
import { Role } from '../domain/role.enum';
import { UserRepository } from '../domain/user.repository';
import { PasswordHasher } from '../domain/password-hasher';
import { TransactionClient } from '../../outbox/domain/transaction-runner';
import { IssueSessionService, TokenPair } from './issue-session.service';

const USER_ID = 'u1';
const EMAIL = 'a@test.com';
const PASSWORD = 'pw123456';
const TOKEN_PAIR: TokenPair = {
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
};

const existing = User.reconstitute({
  id: USER_ID,
  email: EMAIL,
  name: '길동',
  passwordHash: `hashed:${PASSWORD}`,
  role: Role.OWNER,
});
const repo: UserRepository = {
  findByEmail: (email) => Promise.resolve(email === EMAIL ? existing : null),
  save: (u) => Promise.resolve(u),
  saveWithAccount: (u) => Promise.resolve(u),
  findById: () => Promise.resolve(null),
  update: (u) => Promise.resolve(u),
};
const hasher: PasswordHasher = {
  hash: (p) => Promise.resolve(`hashed:${p}`),
  compare: (p, h) => Promise.resolve(h === `hashed:${p}`),
};

// setup(): 매 테스트마다 IssueSessionService mock을 새로 만들어 호출 인자를 검증한다.
function setup() {
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
      .mockResolvedValue(TOKEN_PAIR),
  } satisfies Partial<jest.Mocked<IssueSessionService>>;
  const useCase = new LoginUseCase(
    repo,
    hasher,
    issueSession as unknown as IssueSessionService,
  );
  return { useCase, issueSession };
}

describe('LoginUseCase', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('로그인 성공', () => {
    it('should return both tokens when credentials are valid', async () => {
      const { useCase } = setup();

      const result = await useCase.execute({
        email: EMAIL,
        password: PASSWORD,
      });

      expect(result).toEqual(TOKEN_PAIR);
    });

    it('should not pass familyId so a new session family is created', async () => {
      const { useCase, issueSession } = setup();

      await useCase.execute({ email: EMAIL, password: PASSWORD });

      // 두 번째 인자(familyId)를 넘기면 기존 세션과 뒤섞이므로 undefined여야 한다.
      expect(issueSession.issue.mock.calls[0][1]).toBeUndefined();
    });
  });

  describe('실패 케이스', () => {
    it('없는 이메일이면 Unauthorized', async () => {
      const { useCase } = setup();

      await expect(
        useCase.execute({ email: 'none@test.com', password: 'x' }),
      ).rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' });
    });

    it('비밀번호가 틀리면 Unauthorized', async () => {
      const { useCase } = setup();

      await expect(
        useCase.execute({ email: EMAIL, password: 'wrong' }),
      ).rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' });
    });
  });
});
