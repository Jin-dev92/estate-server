import { Prisma } from '@prisma/client';
import { KakaoLoginUseCase } from './kakao-login.use-case';
import { CompleteKakaoSignupUseCase } from './complete-kakao-signup.use-case';
import { AccountRepository } from '../domain/account.repository';
import { UserRepository } from '../domain/user.repository';
import { KakaoOAuth } from '../domain/kakao-oauth';
import { OnboardingTokenIssuer } from '../domain/onboarding-token';
import { TokenIssuer } from '../domain/token-issuer';
import { Account } from '../domain/account.entity';
import { User } from '../domain/user.entity';
import { AuthProvider } from '../domain/auth-provider';
import { Role } from '../domain/role.enum';

const tokenIssuer: TokenIssuer = { issue: () => Promise.resolve('ACCESS') };
const onboarding: OnboardingTokenIssuer = {
  issue: () => Promise.resolve('ONBOARD'),
  verify: () =>
    Promise.resolve({ providerId: 'k1', email: 'a@b.com', name: '홍' }),
};

describe('KakaoLoginUseCase', () => {
  const kakao = (email: string | null): KakaoOAuth => ({
    exchangeAndFetch: () =>
      Promise.resolve({ providerId: 'k1', email, name: '홍' }),
  });

  it('기존 Account면 accessToken 반환', async () => {
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
    const uc = new KakaoLoginUseCase(
      kakao('a@b.com'),
      accounts as AccountRepository,
      users as UserRepository,
      onboarding,
      tokenIssuer,
    );
    const r = await uc.execute({ code: 'c', redirectUri: 'r' });
    expect(r).toEqual({ accessToken: 'ACCESS' });
  });

  it('신규면 onboardingToken 반환', async () => {
    const accounts: Partial<AccountRepository> = {
      findByProvider: () => Promise.resolve(null),
    };
    const uc = new KakaoLoginUseCase(
      kakao('a@b.com'),
      accounts as AccountRepository,
      {} as UserRepository,
      onboarding,
      tokenIssuer,
    );
    const r = await uc.execute({ code: 'c', redirectUri: 'r' });
    expect(r).toEqual({ onboardingToken: 'ONBOARD' });
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
      tokenIssuer,
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
      tokenIssuer,
    );
    await expect(
      uc.execute({ code: 'c', redirectUri: 'r' }),
    ).rejects.toMatchObject({ code: 'AUTH_USER_NOT_FOUND' });
  });
});

describe('CompleteKakaoSignupUseCase', () => {
  it('정상: User+Account 생성 후 accessToken', async () => {
    const savedAccounts: string[] = [];
    const accounts: Partial<AccountRepository> = {
      findByProvider: () => Promise.resolve(null),
      save: (a) => {
        savedAccounts.push(a.providerId);
        return Promise.resolve(
          Account.reconstitute({
            id: 'a1',
            userId: 'u1',
            provider: AuthProvider.KAKAO,
            providerId: a.providerId,
          }),
        );
      },
    };
    const users: Partial<UserRepository> = {
      save: (u) =>
        Promise.resolve(
          User.reconstitute({
            id: 'u1',
            email: u.email,
            name: u.name,
            passwordHash: null,
            role: u.role,
          }),
        ),
    };
    const uc = new CompleteKakaoSignupUseCase(
      onboarding,
      accounts as AccountRepository,
      users as UserRepository,
      tokenIssuer,
    );
    const r = await uc.execute({
      onboardingToken: 'ONBOARD',
      role: Role.OWNER,
    });
    expect(r).toEqual({ accessToken: 'ACCESS' });
    expect(savedAccounts).toEqual(['k1']);
  });

  it('잘못된 role이면 INVALID_ROLE', async () => {
    const uc = new CompleteKakaoSignupUseCase(
      onboarding,
      {} as AccountRepository,
      {} as UserRepository,
      tokenIssuer,
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
      tokenIssuer,
    );
    await expect(
      uc.execute({ onboardingToken: 'ONBOARD', role: Role.OWNER }),
    ).rejects.toMatchObject({ code: 'AUTH_INVALID_ONBOARDING' });
  });

  it('이미 Account 있으면 users.save 없이 accessToken 반환(멱등)', async () => {
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
      save: () => {
        saveCalled = true;
        return Promise.resolve({} as User);
      },
    };
    const uc = new CompleteKakaoSignupUseCase(
      onboarding,
      accounts as AccountRepository,
      users as UserRepository,
      tokenIssuer,
    );
    const r = await uc.execute({
      onboardingToken: 'ONBOARD',
      role: Role.OWNER,
    });
    expect(r).toEqual({ accessToken: 'ACCESS' });
    expect(saveCalled).toBe(false);
  });

  it('users.save P2002 이면 EMAIL_IN_USE', async () => {
    const accounts: Partial<AccountRepository> = {
      findByProvider: () => Promise.resolve(null),
    };
    const users: Partial<UserRepository> = {
      save: () =>
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
      tokenIssuer,
    );
    await expect(
      uc.execute({ onboardingToken: 'ONBOARD', role: Role.OWNER }),
    ).rejects.toMatchObject({ code: 'AUTH_EMAIL_IN_USE' });
  });
});
