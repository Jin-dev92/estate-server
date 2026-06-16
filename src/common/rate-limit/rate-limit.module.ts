import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { ConfigKey } from '../../config/config-keys';
import { RATE_LIMIT_STORE, RedisRateLimitStore } from './rate-limit.store';
import { RateLimitGuard } from './rate-limit.guard';

// 전역 가드로 등록. RedisModule·ConfigModule은 전역, JwtModule은 여기서 구성(토큰 best-effort 검증용).
@Module({
  imports: [
    ConfigModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>(ConfigKey.JwtSecret),
      }),
    }),
  ],
  providers: [
    { provide: RATE_LIMIT_STORE, useClass: RedisRateLimitStore },
    { provide: APP_GUARD, useClass: RateLimitGuard },
  ],
})
export class RateLimitModule {}
