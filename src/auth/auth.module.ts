import { Module } from '@nestjs/common';
import { JwtModule, JwtSignOptions } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthController } from './interface/auth.controller';
import { JwtStrategy } from './interface/jwt.strategy';
import { SignUpUseCase } from './application/sign-up.use-case';
import { LoginUseCase } from './application/login.use-case';
import { USER_REPOSITORY } from './domain/user.repository';
import { PASSWORD_HASHER } from './domain/password-hasher';
import { TOKEN_ISSUER } from './domain/token-issuer';
import { PrismaUserRepository } from './infrastructure/prisma-user.repository';
import { BcryptPasswordHasher } from './infrastructure/bcrypt-password-hasher';
import { JwtTokenService } from './infrastructure/jwt-token.service';

@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: {
          expiresIn: config.get<string>('JWT_EXPIRES_IN', '1h'),
        } as JwtSignOptions,
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    SignUpUseCase,
    LoginUseCase,
    JwtStrategy,
    { provide: USER_REPOSITORY, useClass: PrismaUserRepository },
    { provide: PASSWORD_HASHER, useClass: BcryptPasswordHasher },
    { provide: TOKEN_ISSUER, useClass: JwtTokenService },
  ],
})
export class AuthModule {}
