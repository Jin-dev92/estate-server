import { SignUpUseCase } from './sign-up.use-case';
import { User } from '../domain/user.entity';
import { UserRepository } from '../domain/user.repository';
import { PasswordHasher } from '../domain/password-hasher';
import { Role } from '../domain/role.enum';

class FakeUserRepo implements UserRepository {
  private users: User[] = [];
  findByEmail(email: string): Promise<User | null> {
    return Promise.resolve(this.users.find((u) => u.email === email) ?? null);
  }
  save(user: User): Promise<User> {
    const saved = User.reconstitute({
      id: 'generated-id',
      email: user.email,
      name: user.name,
      passwordHash: user.passwordHash,
      role: user.role,
    });
    this.users.push(saved);
    return Promise.resolve(saved);
  }
  saveWithAccount(user: User): Promise<User> {
    return this.save(user);
  }
  findById(id: string): Promise<User | null> {
    return Promise.resolve(this.users.find((u) => u.id === id) ?? null);
  }
  update(user: User): Promise<User> {
    return Promise.resolve(user);
  }
}
const fakeHasher: PasswordHasher = {
  hash: (p) => Promise.resolve(`hashed:${p}`),
  compare: (p, h) => Promise.resolve(h === `hashed:${p}`),
};

describe('SignUpUseCase', () => {
  it('신규 이메일이면 비밀번호를 해시해 저장하고 유저를 반환', async () => {
    const repo = new FakeUserRepo();
    const useCase = new SignUpUseCase(repo, fakeHasher);
    const user = await useCase.execute({
      email: 'a@test.com',
      name: '길동',
      password: 'pw123456',
    });
    expect(user.id).toBe('generated-id');
    expect(user.passwordHash).toBe('hashed:pw123456');
  });

  it('role을 OWNER로 지정하면 OWNER 유저를 생성한다', async () => {
    const repo = new FakeUserRepo();
    const useCase = new SignUpUseCase(repo, fakeHasher);
    const user = await useCase.execute({
      email: 'owner@test.com',
      name: '사장',
      password: 'pw123456',
      role: Role.OWNER,
    });
    expect(user.role).toBe('OWNER');
  });

  it('role 미지정이면 기본 TENANT', async () => {
    const repo = new FakeUserRepo();
    const useCase = new SignUpUseCase(repo, fakeHasher);
    const user = await useCase.execute({
      email: 'def@test.com',
      name: '기본',
      password: 'pw123456',
    });
    expect(user.role).toBe('TENANT');
  });

  it('ADMIN 역할로 가입 시도하면 INVALID_ROLE 예외', async () => {
    const repo = new FakeUserRepo();
    const useCase = new SignUpUseCase(repo, fakeHasher);
    await expect(
      useCase.execute({
        email: 'x@test.com',
        name: 'x',
        password: 'pw123456',
        role: Role.ADMIN,
      }),
    ).rejects.toMatchObject({ code: 'AUTH_INVALID_ROLE' });
  });

  it('이미 존재하는 이메일이면 예외', async () => {
    const repo = new FakeUserRepo();
    const useCase = new SignUpUseCase(repo, fakeHasher);
    await useCase.execute({
      email: 'a@test.com',
      name: '길동',
      password: 'pw123456',
    });
    await expect(
      useCase.execute({
        email: 'a@test.com',
        name: '철수',
        password: 'pw999999',
      }),
    ).rejects.toMatchObject({ code: 'AUTH_EMAIL_IN_USE' });
  });
});
