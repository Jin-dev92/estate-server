import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type Redis from 'ioredis';
import { RedisService } from '../../redis/redis.service';
import {
  NotificationRelay,
  NotificationPushPayload,
} from '../domain/notification-relay';

// 모든 main 인스턴스가 구독하는 단일 채널. 워커가 발행하면 gateway가 받아 emit한다.
const CHANNEL = 'notifications';

@Injectable()
export class RedisNotificationRelay
  implements NotificationRelay, OnModuleDestroy
{
  private readonly logger = new Logger(RedisNotificationRelay.name);
  // 구독 전용 커넥션. duplicate()로 만든 별도 연결이라 종료 시 직접 정리해야 한다.
  private sub?: Redis;

  constructor(private readonly redis: RedisService) {}

  async publish(payload: NotificationPushPayload): Promise<void> {
    await this.redis.publish(CHANNEL, JSON.stringify(payload));
  }

  async subscribe(
    handler: (payload: NotificationPushPayload) => void,
  ): Promise<void> {
    // 구독 모드 연결은 일반 명령을 못 쓰므로 전용 연결(duplicate)을 만든다.
    this.sub = this.redis.duplicate();
    await this.sub.subscribe(CHANNEL);
    this.sub.on('message', (_channel: string, raw: string) => {
      try {
        handler(JSON.parse(raw) as NotificationPushPayload);
      } catch (err) {
        this.logger.warn(`알림 중계 파싱 실패: ${(err as Error).message}`);
      }
    });
  }

  // duplicate() 커넥션은 단일 RedisService 밖에 있어 자동 정리되지 않는다.
  // 모듈 종료 시 명시적으로 quit해 연결 누수를 막는다.
  async onModuleDestroy(): Promise<void> {
    if (this.sub) await this.sub.quit();
  }
}
