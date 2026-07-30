import { RefreshToken } from './refresh-token.entity';

const USER_ID = 'user-1';
const TOKEN_HASH = 'hash-1';
const FAMILY_ID = 'family-1';
const NOW = new Date('2026-07-30T00:00:00.000Z');
const FUTURE = new Date('2026-08-13T00:00:00.000Z');
const PAST = new Date('2026-07-29T00:00:00.000Z');

function createToken(overrides?: { expiresAt?: Date }): RefreshToken {
  return RefreshToken.create({
    userId: USER_ID,
    tokenHash: TOKEN_HASH,
    familyId: FAMILY_ID,
    expiresAt: overrides?.expiresAt ?? FUTURE,
  });
}

describe('RefreshToken', () => {
  describe('create', () => {
    it('should start usable with no usedAt and no revokedAt', () => {
      const token = createToken();

      const usable = token.isUsable(NOW);

      expect(usable).toBe(true);
      expect(token.usedAt).toBeNull();
      expect(token.revokedAt).toBeNull();
    });
  });

  describe('isUsable', () => {
    it('should return false when expired', () => {
      const token = createToken({ expiresAt: PAST });

      const usable = token.isUsable(NOW);

      expect(usable).toBe(false);
    });

    it('should return false when already used', () => {
      const token = createToken().markUsed(NOW);

      const usable = token.isUsable(NOW);

      expect(usable).toBe(false);
    });

    it('should return false when revoked', () => {
      const token = createToken().revoke(NOW);

      const usable = token.isUsable(NOW);

      expect(usable).toBe(false);
    });

    it('should return false when expiresAt equals now (만료 시각에 도달한 것은 이미 만료로 본다)', () => {
      const token = createToken({ expiresAt: NOW });

      const usable = token.isUsable(NOW);

      expect(usable).toBe(false);
    });
  });

  describe('isUsed', () => {
    it('should distinguish a consumed token from a merely invalid one', () => {
      const used = createToken().markUsed(NOW);
      const expired = createToken({ expiresAt: PAST });

      expect(used.isUsed()).toBe(true);
      expect(expired.isUsed()).toBe(false);
    });

    it('should return false when only revoked (revocation is not consumption)', () => {
      const revoked = createToken().revoke(NOW);

      expect(revoked.isUsed()).toBe(false);
    });
  });

  describe('markUsed', () => {
    it('should record the consumption time without mutating the original', () => {
      const token = createToken();

      const consumed = token.markUsed(NOW);

      expect(consumed.usedAt).toEqual(NOW);
      expect(token.usedAt).toBeNull();
    });
  });

  describe('revoke', () => {
    it('should record the revocation time without mutating the original', () => {
      const token = createToken();

      const revoked = token.revoke(NOW);

      expect(revoked.revokedAt).toEqual(NOW);
      expect(token.revokedAt).toBeNull();
    });
  });
});
