import { Inject, Injectable } from '@nestjs/common';
import { USER_REPOSITORY, UserRepository } from '../domain/user.repository';
import { PASSWORD_HASHER, PasswordHasher } from '../domain/password-hasher';
import { TOKEN_ISSUER, TokenIssuer } from '../domain/token-issuer';
import { AppException } from '../../common/errors/app-exception';
import { AuthError } from '../auth.errors';

export interface LoginInput {
  email: string;
  password: string;
}

@Injectable()
export class LoginUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(TOKEN_ISSUER) private readonly tokenIssuer: TokenIssuer,
  ) {}

  async execute(input: LoginInput): Promise<{ accessToken: string }> {
    const user = await this.users.findByEmail(input.email);
    if (!user) throw new AppException(AuthError.INVALID_CREDENTIALS);
    // OAuth 가입 유저는 passwordHash가 null — 비밀번호 로그인 불가.
    if (!user.passwordHash)
      throw new AppException(AuthError.INVALID_CREDENTIALS);
    const ok = await this.hasher.compare(input.password, user.passwordHash);
    if (!ok) throw new AppException(AuthError.INVALID_CREDENTIALS);
    const accessToken = await this.tokenIssuer.issue({
      sub: user.id!,
      email: user.email,
      role: user.role,
    });
    return { accessToken };
  }
}
