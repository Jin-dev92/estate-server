import { Injectable } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import { MessageCache } from '../domain/message-cache';
import { ChatMessagePayload } from '../domain/chat-message';

// 방별 최근 메시지 캐시 보관 개수(capped list 길이).
export const RECENT_LIMIT = 50;

function recentKey(roomId: string): string {
  return `chat:room:${roomId}:recent`;
}

@Injectable()
export class RedisMessageCache implements MessageCache {
  constructor(private readonly redis: RedisService) {}

  async push(message: ChatMessagePayload): Promise<void> {
    const key = recentKey(message.roomId);
    // 최신을 앞에 쌓고(LPUSH), 최근 N개로 자른다(LTRIM).
    await this.redis.lpush(key, JSON.stringify(message));
    await this.redis.ltrim(key, 0, RECENT_LIMIT - 1);
  }

  async getRecent(roomId: string, limit: number): Promise<ChatMessagePayload[]> {
    const rows = await this.redis.lrange(recentKey(roomId), 0, limit - 1);
    return rows.map((r) => JSON.parse(r) as ChatMessagePayload);
  }
}
