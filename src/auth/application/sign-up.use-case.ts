import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { User } from '../domain/user.entity';
import { USER_REPOSITORY, UserRepository } from '../domain/user.repository';
import { PASSWORD_HASHER, PasswordHasher } from '../domain/password-hasher';

export interface SignUpInput {
  email: string;
  name: string;
  password: string;
}

@Injectable()
export class SignUpUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
  ) {}

  async execute(input: SignUpInput): Promise<User> {
    const existing = await this.users.findByEmail(input.email);
    if (existing) throw new ConflictException('email already in use');
    const passwordHash = await this.hasher.hash(input.password);
    const user = User.create({
      email: input.email,
      name: input.name,
      passwordHash,
    });
    return this.users.save(user);
  }
}
