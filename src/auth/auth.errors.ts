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
} as const satisfies Record<string, AppErrorSpec>;
