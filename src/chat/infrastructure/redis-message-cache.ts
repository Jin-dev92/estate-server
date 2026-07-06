import { Injectable } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import { MessageCache } from '../domain/message-cache';
import { ChatMessagePayload } from '../domain/chat-message';

// 방별 최근 메시지 캐시 보관 개수(capped list 길이).
export const RECENT_LIMIT = 50;

// 최근 메시지 리스트 TTL(초). LTRIM은 길이만 자를 뿐 키를 만료시키지 않으므로,
// 활동이 끊긴 방의 키가 영구 잔존하지 않도록 push마다 TTL을 슬라이딩해 건다.
// (활성 방은 계속 warm, 마지막 메시지 후 이 시간이 지나면 자연 만료)
export const RECENT_TTL_SEC = 60 * 60 * 24; // 24시간

function recentKey(roomId: string): string {
  return `chat:room:${roomId}:recent`;
}

@Injectable()
export class RedisMessageCache implements MessageCache {
  constructor(private readonly redis: RedisService) {}

  async push(message: ChatMessagePayload): Promise<void> {
    const key = recentKey(message.roomId);
    // 최신을 앞에 쌓고(LPUSH), 최근 N개로 자른(LTRIM) 뒤, TTL을 다시 건다(EXPIRE).
    await this.redis.lpush(key, JSON.stringify(message));
    await this.redis.ltrim(key, 0, RECENT_LIMIT - 1);
    await this.redis.expire(key, RECENT_TTL_SEC);
  }

  async getRecent(
    roomId: string,
    limit: number,
  ): Promise<ChatMessagePayload[]> {
    const rows = await this.redis.lrange(recentKey(roomId), 0, limit - 1);
    return rows.map((r) => JSON.parse(r) as ChatMessagePayload);
  }
}
