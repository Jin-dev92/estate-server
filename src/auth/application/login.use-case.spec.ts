import { LoginUseCase } from './login.use-case';
import { User } from '../domain/user.entity';
import { Role } from '../domain/role.enum';
import { UserRepository } from '../domain/user.repository';
import { PasswordHasher } from '../domain/password-hasher';
import { TokenIssuer } from '../domain/token-issuer';

const existing = User.reconstitute({
  id: 'u1',
  email: 'a@test.com',
  name: '길동',
  passwordHash: 'hashed:pw123456',
  role: Role.OWNER,
});
const repo: UserRepository = {
  findByEmail: (email) =>
    Promise.resolve(email === 'a@test.com' ? existing : null),
  save: (u) => Promise.resolve(u),
  saveWithAccount: (u) => Promise.resolve(u),
  findById: () => Promise.resolve(null),
  update: (u) => Promise.resolve(u),
};
const hasher: PasswordHasher = {
  hash: (p) => Promise.resolve(`hashed:${p}`),
  compare: (p, h) => Promise.resolve(h === `hashed:${p}`),
};
const tokenIssuer: TokenIssuer = {
  issue: (p) => Promise.resolve(`token-for-${p.sub}`),
};

describe('LoginUseCase', () => {
  it('이메일·비밀번호가 맞으면 토큰 발급', async () => {
    const useCase = new LoginUseCase(repo, hasher, tokenIssuer);
    const result = await useCase.execute({
      email: 'a@test.com',
      password: 'pw123456',
    });
    expect(result.accessToken).toBe('token-for-u1');
  });

  it('없는 이메일이면 Unauthorized', async () => {
    const useCase = new LoginUseCase(repo, hasher, tokenIssuer);
    await expect(
      useCase.execute({ email: 'none@test.com', password: 'x' }),
    ).rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' });
  });

  it('비밀번호가 틀리면 Unauthorized', async () => {
    const useCase = new LoginUseCase(repo, hasher, tokenIssuer);
    await expect(
      useCase.execute({ email: 'a@test.com', password: 'wrong' }),
    ).rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' });
  });
});
