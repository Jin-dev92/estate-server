import { Module } from '@nestjs/common';
import { JwtModule, JwtSignOptions } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ConfigKey } from '../config/config-keys';
import { OutboxModule } from '../outbox/outbox.module';
import { AuthController } from './interface/auth.controller';
import { JwtStrategy } from './interface/jwt.strategy';
import { SignUpUseCase } from './application/sign-up.use-case';
import { LoginUseCase } from './application/login.use-case';
import { GetProfileUseCase } from './application/get-profile.use-case';
import { UpdateProfileUseCase } from './application/update-profile.use-case';
import { ChangePasswordUseCase } from './application/change-password.use-case';
import { KakaoLoginUseCase } from './application/kakao-login.use-case';
import { CompleteKakaoSignupUseCase } from './application/complete-kakao-signup.use-case';
import { IssueSessionService } from './application/issue-session.service';
import { RefreshTokensUseCase } from './application/refresh-tokens.use-case';
import { LogoutUseCase } from './application/logout.use-case';
import { LogoutAllUseCase } from './application/logout-all.use-case';
import { ListSessionsUseCase } from './application/list-sessions.use-case';
import { RevokeSessionUseCase } from './application/revoke-session.use-case';
import { USER_REPOSITORY } from './domain/user.repository';
import { PASSWORD_HASHER } from './domain/password-hasher';
import { TOKEN_ISSUER } from './domain/token-issuer';
import { ACCOUNT_REPOSITORY } from './domain/account.repository';
import { KAKAO_OAUTH } from './domain/kakao-oauth';
import { ONBOARDING_TOKEN } from './domain/onboarding-token';
import { REFRESH_TOKEN_REPOSITORY } from './domain/refresh-token.repository';
import { REFRESH_TOKEN_GENERATOR } from './domain/refresh-token-generator';
import { PrismaUserRepository } from './infrastructure/prisma-user.repository';
import { BcryptPasswordHasher } from './infrastructure/bcrypt-password-hasher';
import { JwtTokenService } from './infrastructure/jwt-token.service';
import { PrismaAccountRepository } from './infrastructure/prisma-account.repository';
import { KakaoOAuthClient } from './infrastructure/kakao-oauth.client';
import { KakaoResilience } from './infrastructure/kakao-resilience';
import { OnboardingTokenService } from './infrastructure/onboarding-token.service';
import { PrismaRefreshTokenRepository } from './infrastructure/prisma-refresh-token.repository';
import { CryptoRefreshTokenGenerator } from './infrastructure/crypto-refresh-token-generator';

@Module({
  imports: [
    PassportModule,
    OutboxModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>(ConfigKey.JwtSecret),
        signOptions: {
          expiresIn: config.get<string>(ConfigKey.JwtExpiresIn, '15m'),
        } as JwtSignOptions,
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    SignUpUseCase,
    LoginUseCase,
    GetProfileUseCase,
    UpdateProfileUseCase,
    ChangePasswordUseCase,
    KakaoLoginUseCase,
    CompleteKakaoSignupUseCase,
    IssueSessionService,
    RefreshTokensUseCase,
    LogoutUseCase,
    LogoutAllUseCase,
    ListSessionsUseCase,
    RevokeSessionUseCase,
    JwtStrategy,
    { provide: USER_REPOSITORY, useClass: PrismaUserRepository },
    { provide: PASSWORD_HASHER, useClass: BcryptPasswordHasher },
    { provide: TOKEN_ISSUER, useClass: JwtTokenService },
    { provide: ACCOUNT_REPOSITORY, useClass: PrismaAccountRepository },
    KakaoResilience,
    { provide: KAKAO_OAUTH, useClass: KakaoOAuthClient },
    { provide: ONBOARDING_TOKEN, useClass: OnboardingTokenService },
    {
      provide: REFRESH_TOKEN_REPOSITORY,
      useClass: PrismaRefreshTokenRepository,
    },
    { provide: REFRESH_TOKEN_GENERATOR, useClass: CryptoRefreshTokenGenerator },
  ],
})
export class AuthModule {}
