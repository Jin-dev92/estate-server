import { User } from './user.entity';
import { Role } from './role.enum';

describe('User entity', () => {
  it('create()로 신규 유저를 만들면 기본 역할은 TENANT', () => {
    const user = User.create({
      email: 'a@test.com',
      name: '홍길동',
      passwordHash: 'hashed',
    });
    expect(user.email).toBe('a@test.com');
    expect(user.role).toBe(Role.TENANT);
    expect(user.id).toBeNull();
  });

  it('이메일이 비면 생성 시 예외', () => {
    expect(() =>
      User.create({ email: '', name: '홍길동', passwordHash: 'h' }),
    ).toThrow('email is required');
  });
});
