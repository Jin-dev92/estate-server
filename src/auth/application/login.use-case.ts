import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { USER_REPOSITORY, UserRepository } from '../domain/user.repository';
import { PASSWORD_HASHER, PasswordHasher } from '../domain/password-hasher';
import { TOKEN_ISSUER, TokenIssuer } from '../domain/token-issuer';

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
    if (!user) throw new UnauthorizedException('invalid credentials');
    const ok = await this.hasher.compare(input.password, user.passwordHash);
    if (!ok) throw new UnauthorizedException('invalid credentials');
    const accessToken = await this.tokenIssuer.issue({
      sub: user.id!,
      email: user.email,
      role: user.role,
    });
    return { accessToken };
  }
}
