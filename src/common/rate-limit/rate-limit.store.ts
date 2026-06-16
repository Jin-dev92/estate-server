import { Injectable } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import { FIXED_WINDOW_LUA } from './rate-limit.constants';

export const RATE_LIMIT_STORE = Symbol('RATE_LIMIT_STORE');

export interface RateLimitStore {
  // 키를 1 증가시키고(윈도우 최초면 TTL 설정) 현재 카운트를 반환한다(원자적).
  hit(key: string, windowSec: number): Promise<number>;
}

@Injectable()
export class RedisRateLimitStore implements RateLimitStore {
  constructor(private readonly redis: RedisService) {}

  hit(key: string, windowSec: number): Promise<number> {
    return this.redis.runScript<number>(FIXED_WINDOW_LUA, [key], [windowSec]);
  }
}
