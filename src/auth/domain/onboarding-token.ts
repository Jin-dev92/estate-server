export const ONBOARDING_TOKEN = Symbol('ONBOARDING_TOKEN');

export interface OnboardingPayload {
  providerId: string;
  email: string;
  name: string;
}

export interface OnboardingTokenIssuer {
  issue(payload: OnboardingPayload): Promise<string>;
  verify(token: string): Promise<OnboardingPayload>; // 실패 시 throw
}
