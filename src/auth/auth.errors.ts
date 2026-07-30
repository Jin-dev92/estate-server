import { HttpStatus } from '@nestjs/common';
import { AppErrorSpec } from '../common/errors/app-exception';

export const AuthError = {
  EMAIL_IN_USE: {
    code: 'AUTH_EMAIL_IN_USE',
    status: HttpStatus.CONFLICT,
    message: '이미 사용 중인 이메일입니다.',
  },
  INVALID_CREDENTIALS: {
    code: 'AUTH_INVALID_CREDENTIALS',
    status: HttpStatus.UNAUTHORIZED,
    message: '이메일 또는 비밀번호가 올바르지 않습니다.',
  },
  INSUFFICIENT_ROLE: {
    code: 'AUTH_INSUFFICIENT_ROLE',
    status: HttpStatus.FORBIDDEN,
    message: '권한이 없습니다.',
  },
  INVALID_ROLE: {
    code: 'AUTH_INVALID_ROLE',
    status: HttpStatus.BAD_REQUEST,
    message: '허용되지 않은 역할입니다.',
  },
  USER_NOT_FOUND: {
    code: 'AUTH_USER_NOT_FOUND',
    status: HttpStatus.NOT_FOUND,
    message: '사용자를 찾을 수 없습니다.',
  },
  KAKAO_EMAIL_REQUIRED: {
    code: 'AUTH_KAKAO_EMAIL_REQUIRED',
    status: HttpStatus.BAD_REQUEST,
    message: '카카오 이메일 제공 동의가 필요합니다.',
  },
  INVALID_ONBOARDING: {
    code: 'AUTH_INVALID_ONBOARDING',
    status: HttpStatus.UNAUTHORIZED,
    message: '가입 세션이 만료되었어요. 다시 시도해주세요.',
  },
  KAKAO_UNAVAILABLE: {
    code: 'AUTH_KAKAO_UNAVAILABLE',
    status: HttpStatus.SERVICE_UNAVAILABLE,
    message:
      '카카오 로그인이 일시적으로 원활하지 않습니다. 잠시 후 다시 시도해주세요.',
  },
  INVALID_REFRESH_TOKEN: {
    code: 'AUTH_INVALID_REFRESH_TOKEN',
    status: HttpStatus.UNAUTHORIZED,
    message: '세션이 만료되었습니다. 다시 로그인해주세요.',
  },
  // 이미 회전으로 소비된 토큰의 재제출 = 사본 존재 = 침해 의심.
  // INVALID_REFRESH_TOKEN과 분리하는 이유: 같은 코드로 뭉치면 Sentry에서
  // 침해 신호가 흔한 만료 노이즈에 묻힌다. status는 둘 다 401로 같게 두어
  // 공격자에게 내부 상태를 알려주지 않는다.
  REFRESH_TOKEN_REUSED: {
    code: 'AUTH_REFRESH_TOKEN_REUSED',
    status: HttpStatus.UNAUTHORIZED,
    message: '세션이 만료되었습니다. 다시 로그인해주세요.',
  },
  // 역할 부족(INSUFFICIENT_ROLE)이 아니라 소유권 위반이므로 별도 코드를 둔다.
  // 존재하지 않는 familyId도 이 코드로 응답한다 — 404로 구분하면 남의
  // familyId 존재 여부를 알려주는 정보 노출이 된다.
  NOT_SESSION_OWNER: {
    code: 'AUTH_NOT_SESSION_OWNER',
    status: HttpStatus.FORBIDDEN,
    message: '해당 세션에 대한 권한이 없습니다.',
  },
} as const satisfies Record<string, AppErrorSpec>;
