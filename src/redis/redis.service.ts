import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { ConfigKey } from '../config/config-keys';

@Injectable()
export class RedisService extends Redis implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  // Lua 본문 → SHA 캐시 (EVALSHA로 매번 스크립트 본문 전송 회피)
  private readonly scriptShas = new Map<string, string>();

  constructor(config: ConfigService) {
    super(config.getOrThrow<string>(ConfigKey.RedisUrl));
    // 장수 커넥션: 단절 시 경고만 남기고 ioredis 자동 재연결에 맡긴다(프로세스 크래시 방지)
    this.on('error', (err: Error) =>
      this.logger.warn(`Redis error: ${err.message}`),
    );
  }

  /**
   * Lua 스크립트를 서버측에서 원자 실행한다(분산 환경 안전).
   * EVALSHA로 실행하고, 스크립트 캐시가 없으면(NOSCRIPT) EVAL로 재적재한다.
   */
  async runScript<T = unknown>(
    lua: string,
    keys: string[],
    args: (string | number)[] = [],
  ): Promise<T> {
    let sha = this.scriptShas.get(lua);
    if (!sha) {
      sha = (await this.script('LOAD', lua)) as string;
      this.scriptShas.set(lua, sha);
    }
    try {
      return (await this.evalsha(sha, keys.length, ...keys, ...args)) as T;
    } catch (err) {
      if (err instanceof Error && err.message.includes('NOSCRIPT')) {
        this.scriptShas.delete(lua);
        return (await this.eval(lua, keys.length, ...keys, ...args)) as T;
      }
      throw err;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.quit();
  }
}
