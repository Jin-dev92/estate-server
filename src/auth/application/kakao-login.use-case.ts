import { Inject, Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app-exception';
import { AuthError } from '../auth.errors';
import { AuthProvider } from '../domain/auth-provider';
import {
  ACCOUNT_REPOSITORY,
  AccountRepository,
} from '../domain/account.repository';
import { USER_REPOSITORY, UserRepository } from '../domain/user.repository';
import { KAKAO_OAUTH, KakaoOAuth } from '../domain/kakao-oauth';
import {
  ONBOARDING_TOKEN,
  OnboardingTokenIssuer,
} from '../domain/onboarding-token';
import { IssueSessionService, TokenPair } from './issue-session.service';

export type KakaoLoginResult = TokenPair | { onboardingToken: string };

@Injectable()
export class KakaoLoginUseCase {
  constructor(
    @Inject(KAKAO_OAUTH) private readonly kakao: KakaoOAuth,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepository,
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(ONBOARDING_TOKEN)
    private readonly onboarding: OnboardingTokenIssuer,
    private readonly issueSession: IssueSessionService,
  ) {}

  async execute(input: {
    code: string;
    redirectUri: string;
  }): Promise<KakaoLoginResult> {
    const profile = await this.kakao.exchangeAndFetch(
      input.code,
      input.redirectUri,
    );
    if (!profile.email) throw new AppException(AuthError.KAKAO_EMAIL_REQUIRED);

    const account = await this.accounts.findByProvider(
      AuthProvider.KAKAO,
      profile.providerId,
    );
    if (account) {
      const user = await this.users.findById(account.userId);
      if (!user) throw new AppException(AuthError.USER_NOT_FOUND);
      // familyId를 주지 않으므로 새 가족(= 새 세션)이 만들어진다.
      return this.issueSession.issue({
        userId: user.id!,
        email: user.email,
        role: user.role,
      });
    }

    const onboardingToken = await this.onboarding.issue({
      providerId: profile.providerId,
      email: profile.email,
      name: profile.name,
    });
    return { onboardingToken };
  }
}
