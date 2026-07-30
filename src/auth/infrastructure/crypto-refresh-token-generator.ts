import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
import { ConfigKey } from '../../config/config-keys';
import { RefreshTokenGenerator } from '../domain/refresh-token-generator';

const DEFAULT_TOKEN_BYTES = 32;

@Injectable()
export class CryptoRefreshTokenGenerator implements RefreshTokenGenerator {
  private readonly bytes: number;

  constructor(config: ConfigService) {
    const raw = config.get<string>(
      ConfigKey.RefreshTokenBytes,
      String(DEFAULT_TOKEN_BYTES),
    );
    const parsed = Number.parseInt(raw, 10);
    this.bytes =
      Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TOKEN_BYTES;
  }

  generate(): { token: string; tokenHash: string } {
    // base64url = URL·쿠키에 안전한 인코딩. 패딩(=)이 없다.
    const token = randomBytes(this.bytes).toString('base64url');
    return { token, tokenHash: this.hash(token) };
  }

  // SHA-256을 쓰는 이유: 토큰은 256비트 랜덤이라 무차별 대입이 성립하지
  // 않으므로 bcrypt처럼 느릴 필요가 없다. bcrypt를 쓰면 M8에서 확인한
  // CPU 바운드 비용(login p95 114ms)을 갱신 경로에 옮겨오게 된다.
  hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
