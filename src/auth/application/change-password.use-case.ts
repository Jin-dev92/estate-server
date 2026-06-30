import { Inject, Injectable } from '@nestjs/common';
import { USER_REPOSITORY, UserRepository } from '../domain/user.repository';
import { PASSWORD_HASHER, PasswordHasher } from '../domain/password-hasher';
import { AppException } from '../../common/errors/app-exception';
import { AuthError } from '../auth.errors';

@Injectable()
export class ChangePasswordUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
  ) {}

  async execute(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = await this.users.findById(userId);
    if (!user) throw new AppException(AuthError.USER_NOT_FOUND);
    // OAuth 가입 유저는 passwordHash가 null — 비밀번호 변경 불가.
    if (!user.passwordHash)
      throw new AppException(AuthError.INVALID_CREDENTIALS);
    const ok = await this.hasher.compare(currentPassword, user.passwordHash);
    if (!ok) throw new AppException(AuthError.INVALID_CREDENTIALS);
    const newHash = await this.hasher.hash(newPassword);
    await this.users.update(user.changePassword(newHash));
  }
}
