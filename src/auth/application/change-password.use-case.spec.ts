import { ChangePasswordUseCase } from './change-password.use-case';
import { UserRepository } from '../domain/user.repository';
import { PasswordHasher } from '../domain/password-hasher';
import { User } from '../domain/user.entity';
import { Role } from '../domain/role.enum';

function user(): User {
  return User.reconstitute({
    id: 'u1',
    email: 'a@b.com',
    name: '김철수',
    passwordHash: 'OLD_HASH',
    role: Role.TENANT,
  });
}

function build(compareResult: boolean) {
  const updatedHashes: string[] = [];
  const users: Partial<UserRepository> = {
    findById: () => Promise.resolve(user()),
    update: (u) => {
      updatedHashes.push(u.passwordHash ?? "");
      return Promise.resolve(u);
    },
  };
  const hasher: Partial<PasswordHasher> = {
    compare: () => Promise.resolve(compareResult),
    hash: () => Promise.resolve('NEW_HASH'),
  };
  const useCase = new ChangePasswordUseCase(
    users as UserRepository,
    hasher as PasswordHasher,
  );
  return { useCase, updatedHashes };
}

describe('ChangePasswordUseCase', () => {
  afterEach(() => jest.clearAllMocks());

  it('현재 비번이 맞으면 새 해시로 update', async () => {
    const { useCase, updatedHashes } = build(true);
    await useCase.execute('u1', 'current', 'newpass12');
    expect(updatedHashes).toEqual(['NEW_HASH']);
  });

  it('현재 비번이 틀리면 INVALID_CREDENTIALS, update 안 함', async () => {
    const { useCase, updatedHashes } = build(false);
    await expect(
      useCase.execute('u1', 'wrong', 'newpass12'),
    ).rejects.toMatchObject({
      code: 'AUTH_INVALID_CREDENTIALS',
    });
    expect(updatedHashes).toEqual([]);
  });

  it('사용자가 없으면 USER_NOT_FOUND', async () => {
    const users: Partial<UserRepository> = {
      findById: () => Promise.resolve(null),
    };
    const hasher: Partial<PasswordHasher> = {
      compare: () => Promise.resolve(true),
      hash: () => Promise.resolve('NEW_HASH'),
    };
    const useCase = new ChangePasswordUseCase(
      users as UserRepository,
      hasher as PasswordHasher,
    );
    await expect(useCase.execute('u1', 'c', 'newpass12')).rejects.toMatchObject(
      { code: 'AUTH_USER_NOT_FOUND' },
    );
  });
});
