import { SetMetadata } from '@nestjs/common';
import {
  RATE_LIMIT_OPTIONS,
  RATE_LIMIT_SKIP,
  RateLimitOptions,
} from './rate-limit.constants';

// 라우트별 한도 오버라이드. 예: @RateLimit({ ipMax: 10 })
export const RateLimit = (options: RateLimitOptions) =>
  SetMetadata(RATE_LIMIT_OPTIONS, options);

// 해당 라우트는 rate limit에서 제외.
export const SkipRateLimit = () => SetMetadata(RATE_LIMIT_SKIP, true);
