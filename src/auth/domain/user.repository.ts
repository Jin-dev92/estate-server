import { User } from './user.entity';

export const USER_REPOSITORY = Symbol('USER_REPOSITORY');

export interface UserRepository {
  findByEmail(email: string): Promise<User | null>;
  save(user: User): Promise<User>;
  // User와 첫 OAuth Account를 한 트랜잭션(Prisma nested write)으로 함께 생성한다.
  // 예외(P2002 등)는 호출부에서 처리하도록 그대로 전파한다.
  saveWithAccount(
    user: User,
    link: { provider: string; providerId: string },
  ): Promise<User>;
  findById(id: string): Promise<User | null>;
  update(user: User): Promise<User>;
}
