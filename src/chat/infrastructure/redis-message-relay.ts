import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import { MessageRelay } from '../domain/message-relay';
import { ChatMessagePayload } from '../domain/chat-message';

// 모든 인스턴스가 구독하는 단일 채널. 수신 시 roomId로 로컬 room에 중계한다.
const CHANNEL = 'chat:messages';

@Injectable()
export class RedisMessageRelay implements MessageRelay {
  private readonly logger = new Logger(RedisMessageRelay.name);

  constructor(private readonly redis: RedisService) {}

  async publish(message: ChatMessagePayload): Promise<void> {
    await this.redis.publish(CHANNEL, JSON.stringify(message));
  }

  async subscribe(
    handler: (message: ChatMessagePayload) => void,
  ): Promise<void> {
    // 구독 모드 연결은 일반 명령을 못 쓰므로 전용 연결(duplicate)을 만든다.
    const sub = this.redis.duplicate();
    await sub.subscribe(CHANNEL);
    sub.on('message', (_channel: string, raw: string) => {
      try {
        handler(JSON.parse(raw) as ChatMessagePayload);
      } catch (err) {
        this.logger.warn(`중계 메시지 파싱 실패: ${(err as Error).message}`);
      }
    });
  }
}
