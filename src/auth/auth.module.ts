import { Module } from '@nestjs/common';
import { JwtModule, JwtSignOptions } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ConfigKey } from '../config/config-keys';
import { AuthController } from './interface/auth.controller';
import { JwtStrategy } from './interface/jwt.strategy';
import { SignUpUseCase } from './application/sign-up.use-case';
import { LoginUseCase } from './application/login.use-case';
import { GetProfileUseCase } from './application/get-profile.use-case';
import { UpdateProfileUseCase } from './application/update-profile.use-case';
import { ChangePasswordUseCase } from './application/change-password.use-case';
import { KakaoLoginUseCase } from './application/kakao-login.use-case';
import { CompleteKakaoSignupUseCase } from './application/complete-kakao-signup.use-case';
import { USER_REPOSITORY } from './domain/user.repository';
import { PASSWORD_HASHER } from './domain/password-hasher';
import { TOKEN_ISSUER } from './domain/token-issuer';
import { ACCOUNT_REPOSITORY } from './domain/account.repository';
import { KAKAO_OAUTH } from './domain/kakao-oauth';
import { ONBOARDING_TOKEN } from './domain/onboarding-token';
import { PrismaUserRepository } from './infrastructure/prisma-user.repository';
import { BcryptPasswordHasher } from './infrastructure/bcrypt-password-hasher';
import { JwtTokenService } from './infrastructure/jwt-token.service';
import { PrismaAccountRepository } from './infrastructure/prisma-account.repository';
import { KakaoOAuthClient } from './infrastructure/kakao-oauth.client';
import { OnboardingTokenService } from './infrastructure/onboarding-token.service';

@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>(ConfigKey.JwtSecret),
        signOptions: {
          expiresIn: config.get<string>(ConfigKey.JwtExpiresIn, '1h'),
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
    JwtStrategy,
    { provide: USER_REPOSITORY, useClass: PrismaUserRepository },
    { provide: PASSWORD_HASHER, useClass: BcryptPasswordHasher },
    { provide: TOKEN_ISSUER, useClass: JwtTokenService },
    { provide: ACCOUNT_REPOSITORY, useClass: PrismaAccountRepository },
    { provide: KAKAO_OAUTH, useClass: KakaoOAuthClient },
    { provide: ONBOARDING_TOKEN, useClass: OnboardingTokenService },
  ],
})
export class AuthModule {}
