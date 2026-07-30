import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { CryptoRefreshTokenGenerator } from './crypto-refresh-token-generator';

const TOKEN_BYTES = 32;
// 32바이트를 base64url(패딩 없음)로 인코딩하면 항상 43문자다: ceil(32*8/6).
const DEFAULT_TOKEN_BASE64URL_LENGTH = 43;

function createGenerator(
  envValue: string = String(TOKEN_BYTES),
): CryptoRefreshTokenGenerator {
  const config = {
    get: jest.fn().mockReturnValue(envValue),
  } satisfies Partial<jest.Mocked<ConfigService>>;

  return new CryptoRefreshTokenGenerator(config as unknown as ConfigService);
}

describe('CryptoRefreshTokenGenerator', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('generate', () => {
    it('should return a token whose hash is sha256 of the token', () => {
      const generator = createGenerator();

      const { token, tokenHash } = generator.generate();

      expect(tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
    });

    it('should never return the raw token as its own hash', () => {
      const generator = createGenerator();

      const { token, tokenHash } = generator.generate();

      expect(tokenHash).not.toBe(token);
    });

    it('should produce a different token on each call', () => {
      const generator = createGenerator();

      const first = generator.generate();
      const second = generator.generate();

      expect(first.token).not.toBe(second.token);
    });

    it('should use base64url encoding without padding characters', () => {
      const generator = createGenerator();

      const { token } = generator.generate();

      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    });
  });

  describe('hash', () => {
    it('should be deterministic for the same input', () => {
      const generator = createGenerator();
      const input = 'some-token';

      const first = generator.hash(input);
      const second = generator.hash(input);

      expect(first).toBe(second);
    });
  });

  // 생성자의 REFRESH_TOKEN_BYTES 파싱 폴백(`Number.isFinite(parsed) && parsed > 0`
  // 이 아니면 DEFAULT_TOKEN_BYTES=32)을 검증한다. 기존 테스트는 전부 유효한
  // env 값("32")만 사용해서, 이 조건의 비교 연산자를 뒤집거나(`>=`) isFinite
  // 검사를 지워도 아무 테스트도 깨지지 않는 사각지대였다.
  describe('생성자 — env 파싱 폴백', () => {
    it('빈 문자열이면 기본값 32바이트로 폴백한다', () => {
      const generator = createGenerator('');

      const { token } = generator.generate();

      expect(token).toHaveLength(DEFAULT_TOKEN_BASE64URL_LENGTH);
    });

    it('숫자가 아닌 문자열이면 기본값 32바이트로 폴백한다', () => {
      const generator = createGenerator('abc');

      const { token } = generator.generate();

      expect(token).toHaveLength(DEFAULT_TOKEN_BASE64URL_LENGTH);
    });

    it("'0'이면 기본값 32바이트로 폴백한다", () => {
      const generator = createGenerator('0');

      const { token } = generator.generate();

      expect(token).toHaveLength(DEFAULT_TOKEN_BASE64URL_LENGTH);
    });

    it('음수 문자열이면 기본값 32바이트로 폴백한다', () => {
      const generator = createGenerator('-8');

      const { token } = generator.generate();

      expect(token).toHaveLength(DEFAULT_TOKEN_BASE64URL_LENGTH);
    });

    it('유효한 env 값이 실제로 바이트 길이에 반영된다', () => {
      const SMALL_TOKEN_BYTES = 16;
      const generator = createGenerator(String(SMALL_TOKEN_BYTES));

      const { token } = generator.generate();

      expect(token).not.toHaveLength(DEFAULT_TOKEN_BASE64URL_LENGTH);
    });
  });
});
