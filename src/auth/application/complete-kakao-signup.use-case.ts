import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppException } from '../../common/errors/app-exception';
import { AuthError } from '../auth.errors';
import { Role } from '../domain/role.enum';
import { AuthProvider } from '../domain/auth-provider';
import { User } from '../domain/user.entity';
import {
  ACCOUNT_REPOSITORY,
  AccountRepository,
} from '../domain/account.repository';
import { USER_REPOSITORY, UserRepository } from '../domain/user.repository';
import {
  ONBOARDING_TOKEN,
  OnboardingTokenIssuer,
  OnboardingPayload,
} from '../domain/onboarding-token';
import { TOKEN_ISSUER, TokenIssuer } from '../domain/token-issuer';

const ALLOWED: Role[] = [Role.OWNER, Role.TENANT];

@Injectable()
export class CompleteKakaoSignupUseCase {
  constructor(
    @Inject(ONBOARDING_TOKEN)
    private readonly onboarding: OnboardingTokenIssuer,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepository,
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(TOKEN_ISSUER) private readonly tokenIssuer: TokenIssuer,
  ) {}

  async execute(input: {
    onboardingToken: string;
    role: Role;
  }): Promise<{ accessToken: string }> {
    if (!ALLOWED.includes(input.role))
      throw new AppException(AuthError.INVALID_ROLE);

    let payload: OnboardingPayload;
    try {
      payload = await this.onboarding.verify(input.onboardingToken);
    } catch {
      throw new AppException(AuthError.INVALID_ONBOARDING);
    }

    // 멱등: 이미 연결된 Account면 그 User로 발급.
    const existing = await this.accounts.findByProvider(
      AuthProvider.KAKAO,
      payload.providerId,
    );
    if (existing) {
      const user = await this.users.findById(existing.userId);
      if (!user) throw new AppException(AuthError.USER_NOT_FOUND);
      return {
        accessToken: await this.tokenIssuer.issue({
          sub: user.id!,
          email: user.email,
          role: user.role,
        }),
      };
    }

    let user: User;
    try {
      // User+Account를 nested write로 원자 생성(account 실패 시 user도 롤백 → 고아 방지).
      user = await this.users.saveWithAccount(
        User.createOAuth({
          email: payload.email,
          name: payload.name,
          role: input.role,
        }),
        { provider: AuthProvider.KAKAO, providerId: payload.providerId },
      );
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new AppException(AuthError.EMAIL_IN_USE);
      }
      throw e;
    }
    return {
      accessToken: await this.tokenIssuer.issue({
        sub: user.id!,
        email: user.email,
        role: user.role,
      }),
    };
  }
}
