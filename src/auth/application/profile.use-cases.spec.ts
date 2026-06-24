import { GetProfileUseCase } from './get-profile.use-case';
import { UpdateProfileUseCase } from './update-profile.use-case';
import { UserRepository } from '../domain/user.repository';
import { User } from '../domain/user.entity';
import { Role } from '../domain/role.enum';

function sampleUser(name = '김철수'): User {
  return User.reconstitute({
    id: 'u1',
    email: 'a@b.com',
    name,
    passwordHash: 'hash',
    role: Role.TENANT,
  });
}

describe('프로필 유스케이스', () => {
  it('GetProfile: findById 결과를 반환', async () => {
    const repo: Partial<UserRepository> = {
      findById: () => Promise.resolve(sampleUser()),
    };
    const useCase = new GetProfileUseCase(repo as UserRepository);
    const user = await useCase.execute('u1');
    expect(user.name).toBe('김철수');
  });

  it('GetProfile: 없으면 USER_NOT_FOUND', async () => {
    const repo: Partial<UserRepository> = {
      findById: () => Promise.resolve(null),
    };
    const useCase = new GetProfileUseCase(repo as UserRepository);
    await expect(useCase.execute('u1')).rejects.toMatchObject({
      code: 'AUTH_USER_NOT_FOUND',
    });
  });

  it('UpdateProfile: 이름을 바꿔 update를 호출', async () => {
    const updated: string[] = [];
    const repo: Partial<UserRepository> = {
      findById: () => Promise.resolve(sampleUser()),
      update: (u) => {
        updated.push(u.name);
        return Promise.resolve(u);
      },
    };
    const useCase = new UpdateProfileUseCase(repo as UserRepository);
    const result = await useCase.execute('u1', '이영희');
    expect(result.name).toBe('이영희');
    expect(updated).toEqual(['이영희']);
  });
});
