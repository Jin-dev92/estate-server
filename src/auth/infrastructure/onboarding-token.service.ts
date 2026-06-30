import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  OnboardingPayload,
  OnboardingTokenIssuer,
} from '../domain/onboarding-token';

const TYP = 'kakao_onboarding';

@Injectable()
export class OnboardingTokenService implements OnboardingTokenIssuer {
  constructor(private readonly jwt: JwtService) {}

  issue(payload: OnboardingPayload): Promise<string> {
    return this.jwt.signAsync({ ...payload, typ: TYP }, { expiresIn: '10m' });
  }

  async verify(token: string): Promise<OnboardingPayload> {
    const decoded = await this.jwt.verifyAsync<
      OnboardingPayload & { typ?: string }
    >(token);
    if (decoded.typ !== TYP) throw new Error('onboarding 토큰이 아님');
    return {
      providerId: decoded.providerId,
      email: decoded.email,
      name: decoded.name,
    };
  }
}
