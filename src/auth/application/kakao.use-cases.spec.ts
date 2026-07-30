import { Prisma } from '@prisma/client';
import { KakaoLoginUseCase } from './kakao-login.use-case';
import { CompleteKakaoSignupUseCase } from './complete-kakao-signup.use-case';
import { AccountRepository } from '../domain/account.repository';
import { UserRepository } from '../domain/user.repository';
import { KakaoOAuth } from '../domain/kakao-oauth';
import { OnboardingTokenIssuer } from '../domain/onboarding-token';
import { Account } from '../domain/account.entity';
import { User } from '../domain/user.entity';
import { AuthProvider } from '../domain/auth-provider';
import { Role } from '../domain/role.enum';
import { TransactionClient } from '../../outbox/domain/transaction-runner';
import { IssueSessionService, TokenPair } from './issue-session.service';

const TOKEN_PAIR: TokenPair = {
  accessToken: 'ACCESS',
  refreshToken: 'REFRESH',
};
const onboarding: OnboardingTokenIssuer = {
  issue: () => Promise.resolve('ONBOARD'),
  verify: () =>
    Promise.resolve({ providerId: 'k1', email: 'a@b.com', name: '홍' }),
};

// createIssueSession(): 매 테스트마다 새 mock을 만들어 호출 인자(특히 familyId)를 검증한다.
function createIssueSession() {
  return {
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
}

describe('KakaoLoginUseCase', () => {
  const kakao = (email: string | null): KakaoOAuth => ({
    exchangeAndFetch: () =>
      Promise.resolve({ providerId: 'k1', email, name: '홍' }),
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('기존 Account면 토큰 쌍 반환', async () => {
    const accounts: Partial<AccountRepository> = {
      findByProvider: () =>
        Promise.resolve(
          Account.reconstitute({
            id: 'a1',
            userId: 'u1',
            provider: AuthProvider.KAKAO,
            providerId: 'k1',
          }),
        ),
    };
    const users: Partial<UserRepository> = {
      findById: () =>
        Promise.resolve(
          User.reconstitute({
            id: 'u1',
            email: 'a@b.com',
            name: '홍',
            passwordHash: null,
            role: Role.TENANT,
          }),
        ),
    };
    const issueSession = createIssueSession();
    const uc = new KakaoLoginUseCase(
      kakao('a@b.com'),
      accounts as AccountRepository,
      users as UserRepository,
      onboarding,
      issueSession as unknown as IssueSessionService,
    );

    const r = await uc.execute({ code: 'c', redirectUri: 'r' });

    expect(r).toEqual(TOKEN_PAIR);
    // 두 번째 인자(familyId)를 넘기면 기존 세션과 뒤섞이므로 undefined여야 한다.
    expect(issueSession.issue.mock.calls[0][1]).toBeUndefined();
  });

  it('신규면 onboardingToken 반환', async () => {
    const accounts: Partial<AccountRepository> = {
      findByProvider: () => Promise.resolve(null),
    };
    const issueSession = createIssueSession();
    const uc = new KakaoLoginUseCase(
      kakao('a@b.com'),
      accounts as AccountRepository,
      {} as UserRepository,
      onboarding,
      issueSession as unknown as IssueSessionService,
    );

    const r = await uc.execute({ code: 'c', redirectUri: 'r' });

    expect(r).toEqual({ onboardingToken: 'ONBOARD' });
    expect(issueSession.issue).not.toHaveBeenCalled();
  });

  it('이메일 없으면 KAKAO_EMAIL_REQUIRED', async () => {
    const accounts: Partial<AccountRepository> = {
      findByProvider: () => Promise.resolve(null),
    };
    const uc = new KakaoLoginUseCase(
      kakao(null),
      accounts as AccountRepository,
      {} as UserRepository,
      onboarding,
      createIssueSession() as unknown as IssueSessionService,
    );
    await expect(
      uc.execute({ code: 'c', redirectUri: 'r' }),
    ).rejects.toMatchObject({ code: 'AUTH_KAKAO_EMAIL_REQUIRED' });
  });

  it('Account는 있으나 User 없으면 USER_NOT_FOUND', async () => {
    const accounts: Partial<AccountRepository> = {
      findByProvider: () =>
        Promise.resolve(
          Account.reconstitute({
            id: 'a1',
            userId: 'u1',
            provider: AuthProvider.KAKAO,
            providerId: 'k1',
          }),
        ),
    };
    const users: Partial<UserRepository> = {
      findById: () => Promise.resolve(null),
    };
    const uc = new KakaoLoginUseCase(
      kakao('a@b.com'),
      accounts as AccountRepository,
      users as UserRepository,
      onboarding,
      createIssueSession() as unknown as IssueSessionService,
    );
    await expect(
      uc.execute({ code: 'c', redirectUri: 'r' }),
    ).rejects.toMatchObject({ code: 'AUTH_USER_NOT_FOUND' });
  });
});

describe('CompleteKakaoSignupUseCase', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('정상: User+Account를 saveWithAccount로 함께 생성 후 토큰 쌍', async () => {
    const linkedProviderIds: string[] = [];
    const accounts: Partial<AccountRepository> = {
      findByProvider: () => Promise.resolve(null),
    };
    const users: Partial<UserRepository> = {
      saveWithAccount: (u, link) => {
        linkedProviderIds.push(link.providerId);
        return Promise.resolve(
          User.reconstitute({
            id: 'u1',
            email: u.email,
            name: u.name,
            passwordHash: null,
            role: u.role,
          }),
        );
      },
    };
    const issueSession = createIssueSession();
    const uc = new CompleteKakaoSignupUseCase(
      onboarding,
      accounts as AccountRepository,
      users as UserRepository,
      issueSession as unknown as IssueSessionService,
    );

    const r = await uc.execute({
      onboardingToken: 'ONBOARD',
      role: Role.OWNER,
    });

    expect(r).toEqual(TOKEN_PAIR);
    expect(linkedProviderIds).toEqual(['k1']);
    // 신규 가입도 새 세션이므로 familyId를 넘기면 안 된다.
    expect(issueSession.issue.mock.calls[0][1]).toBeUndefined();
  });

  it('잘못된 role이면 INVALID_ROLE', async () => {
    const uc = new CompleteKakaoSignupUseCase(
      onboarding,
      {} as AccountRepository,
      {} as UserRepository,
      createIssueSession() as unknown as IssueSessionService,
    );
    await expect(
      uc.execute({ onboardingToken: 'ONBOARD', role: 'ADMIN' as Role }),
    ).rejects.toMatchObject({ code: 'AUTH_INVALID_ROLE' });
  });

  it('onboarding.verify 실패하면 INVALID_ONBOARDING', async () => {
    const badOnboarding: OnboardingTokenIssuer = {
      issue: () => Promise.resolve('ONBOARD'),
      verify: () => Promise.reject(new Error('expired')),
    };
    const uc = new CompleteKakaoSignupUseCase(
      badOnboarding,
      {} as AccountRepository,
      {} as UserRepository,
      createIssueSession() as unknown as IssueSessionService,
    );
    await expect(
      uc.execute({ onboardingToken: 'ONBOARD', role: Role.OWNER }),
    ).rejects.toMatchObject({ code: 'AUTH_INVALID_ONBOARDING' });
  });

  it('이미 Account 있으면 saveWithAccount 없이 토큰 쌍 반환(멱등)', async () => {
    let saveCalled = false;
    const accounts: Partial<AccountRepository> = {
      findByProvider: () =>
        Promise.resolve(
          Account.reconstitute({
            id: 'a1',
            userId: 'u1',
            provider: AuthProvider.KAKAO,
            providerId: 'k1',
          }),
        ),
    };
    const users: Partial<UserRepository> = {
      findById: () =>
        Promise.resolve(
          User.reconstitute({
            id: 'u1',
            email: 'a@b.com',
            name: '홍',
            passwordHash: null,
            role: Role.TENANT,
          }),
        ),
      saveWithAccount: () => {
        saveCalled = true;
        return Promise.resolve({} as User);
      },
    };
    const issueSession = createIssueSession();
    const uc = new CompleteKakaoSignupUseCase(
      onboarding,
      accounts as AccountRepository,
      users as UserRepository,
      issueSession as unknown as IssueSessionService,
    );

    const r = await uc.execute({
      onboardingToken: 'ONBOARD',
      role: Role.OWNER,
    });

    expect(r).toEqual(TOKEN_PAIR);
    expect(saveCalled).toBe(false);
    // 멱등 분기도 새 세션이므로 familyId를 넘기면 안 된다.
    expect(issueSession.issue.mock.calls[0][1]).toBeUndefined();
  });

  it('saveWithAccount P2002 이면 EMAIL_IN_USE', async () => {
    const accounts: Partial<AccountRepository> = {
      findByProvider: () => Promise.resolve(null),
    };
    const users: Partial<UserRepository> = {
      saveWithAccount: () =>
        Promise.reject(
          new Prisma.PrismaClientKnownRequestError('dup', {
            code: 'P2002',
            clientVersion: 'test',
          }),
        ),
    };
    const uc = new CompleteKakaoSignupUseCase(
      onboarding,
      accounts as AccountRepository,
      users as UserRepository,
      createIssueSession() as unknown as IssueSessionService,
    );
    await expect(
      uc.execute({ onboardingToken: 'ONBOARD', role: Role.OWNER }),
    ).rejects.toMatchObject({ code: 'AUTH_EMAIL_IN_USE' });
  });
});
