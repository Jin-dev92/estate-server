import { JwtService } from '@nestjs/jwt';
import { OnboardingTokenService } from './onboarding-token.service';

const jwt = new JwtService({ secret: 'test-secret' });
const svc = new OnboardingTokenService(jwt);

describe('OnboardingTokenService', () => {
  it('issue→verify 왕복으로 payload 복원', async () => {
    const token = await svc.issue({
      providerId: 'k1',
      email: 'a@b.com',
      name: '홍길동',
    });
    const p = await svc.verify(token);
    expect(p).toEqual({ providerId: 'k1', email: 'a@b.com', name: '홍길동' });
  });

  it('일반 access token(typ 없음)은 verify에서 거부', async () => {
    const wrong = await jwt.signAsync({ sub: 'u1', email: 'a@b.com' });
    await expect(svc.verify(wrong)).rejects.toBeDefined();
  });
});
