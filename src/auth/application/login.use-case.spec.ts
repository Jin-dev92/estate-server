import { LoginUseCase } from './login.use-case';
import { User } from '../domain/user.entity';
import { Role } from '../domain/role.enum';
import { UserRepository } from '../domain/user.repository';
import { PasswordHasher } from '../domain/password-hasher';
import { TransactionClient } from '../../outbox/domain/transaction-runner';
import { IssueSessionService, TokenPair } from './issue-session.service';

const USER_ID = 'u1';
const EMAIL = 'a@test.com';
const OAUTH_USER_ID = 'u2';
const OAUTH_EMAIL = 'oauth@test.com';
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
// OAuth(카카오 등)로 가입한 유저는 passwordHash가 null이다.
const oauthUser = User.reconstitute({
  id: OAUTH_USER_ID,
  email: OAUTH_EMAIL,
  name: '오어스',
  passwordHash: null,
  role: Role.TENANT,
});
const repo: UserRepository = {
  findByEmail: (email) => {
    if (email === EMAIL) return Promise.resolve(existing);
    if (email === OAUTH_EMAIL) return Promise.resolve(oauthUser);
    return Promise.resolve(null);
  },
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

    it('should call issueSession.issue with the authenticated user and no familyId', async () => {
      const { useCase, issueSession } = setup();

      await useCase.execute({ email: EMAIL, password: PASSWORD });

      // mock을 TOKEN_ISSUER에서 IssueSessionService로 교체하며 사라졌던 검증을 복원한다.
      // 인자가 실제 조회된 유저(userId/email/role)와 정확히 일치하는지 확인한다.
      // toHaveBeenCalledWith는 인자 개수까지 정확히 비교하므로, familyId를 추가로
      // 넘기지 않았다는 것(기존 세션과 뒤섞이지 않음)도 이 한 줄로 함께 검증된다.
      expect(issueSession.issue).toHaveBeenCalledWith({
        userId: USER_ID,
        email: EMAIL,
        role: Role.OWNER,
      });
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

    it('OAuth 가입 유저(passwordHash null)는 비밀번호 로그인이 거절되고 세션도 발급되지 않는다', async () => {
      expect.assertions(2);
      const { useCase, issueSession } = setup();

      await expect(
        useCase.execute({ email: OAUTH_EMAIL, password: PASSWORD }),
      ).rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' });
      expect(issueSession.issue).not.toHaveBeenCalled();
    });
  });
});
