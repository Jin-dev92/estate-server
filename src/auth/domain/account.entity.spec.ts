import { Account } from './account.entity';
import { AuthProvider } from './auth-provider';

describe('Account', () => {
  it('create: provider/providerId/userId를 보관하고 id는 null', () => {
    const a = Account.create({
      userId: 'u1',
      provider: AuthProvider.KAKAO,
      providerId: 'k123',
    });
    expect(a.userId).toBe('u1');
    expect(a.provider).toBe('KAKAO');
    expect(a.providerId).toBe('k123');
    expect(a.id).toBeNull();
  });

  it('reconstitute: 저장된 행을 복원', () => {
    const a = Account.reconstitute({
      id: 'a1',
      userId: 'u1',
      provider: AuthProvider.KAKAO,
      providerId: 'k123',
    });
    expect(a.id).toBe('a1');
  });
});
