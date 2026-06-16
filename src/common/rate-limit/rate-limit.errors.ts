import { HttpStatus } from '@nestjs/common';
import { AppErrorSpec } from '../errors/app-exception';

export const RateLimitError = {
  EXCEEDED: {
    code: 'RATE_LIMIT_EXCEEDED',
    status: HttpStatus.TOO_MANY_REQUESTS,
    message: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.',
  },
} as const satisfies Record<string, AppErrorSpec>;
