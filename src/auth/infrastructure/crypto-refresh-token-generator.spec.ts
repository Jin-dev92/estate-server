import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { CryptoRefreshTokenGenerator } from './crypto-refresh-token-generator';

const TOKEN_BYTES = 32;

function createGenerator(): CryptoRefreshTokenGenerator {
  const config = {
    get: jest.fn().mockReturnValue(String(TOKEN_BYTES)),
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

      expect(tokenHash).toBe(
        createHash('sha256').update(token).digest('hex'),
      );
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
});
