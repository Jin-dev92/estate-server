import { PrismaService } from '../../prisma/prisma.service';
import { RefreshToken } from '../domain/refresh-token.entity';
import { PrismaRefreshTokenRepository } from './prisma-refresh-token.repository';

const USER_ID = 'user-1';
const FAMILY_ID = 'family-1';
const TOKEN_HASH = 'hash-1';
const TOKEN_ID = 'token-1';
const NOW = new Date('2026-07-30T00:00:00.000Z');
const EXPIRES_AT = new Date('2026-08-13T00:00:00.000Z');

function createDelegate() {
  return {
    create: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    findMany: jest.fn(),
    findFirst: jest.fn(),
  };
}

function createRepo(delegate: ReturnType<typeof createDelegate>) {
  const prisma = { refreshToken: delegate };
  return new PrismaRefreshTokenRepository(
    prisma as unknown as PrismaService,
  );
}

describe('PrismaRefreshTokenRepository', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('findByHash', () => {
    it('should map a row to a RefreshToken entity', async () => {
      const delegate = createDelegate();
      delegate.findUnique.mockResolvedValue({
        id: TOKEN_ID,
        userId: USER_ID,
        tokenHash: TOKEN_HASH,
        familyId: FAMILY_ID,
        expiresAt: EXPIRES_AT,
        usedAt: null,
        revokedAt: null,
      });
      const repo = createRepo(delegate);

      const found = await repo.findByHash(TOKEN_HASH);

      expect(found?.id).toBe(TOKEN_ID);
      expect(found?.familyId).toBe(FAMILY_ID);
      expect(found?.isUsable(NOW)).toBe(true);
    });

    it('should return null when no row matches', async () => {
      const delegate = createDelegate();
      delegate.findUnique.mockResolvedValue(null);
      const repo = createRepo(delegate);

      const found = await repo.findByHash(TOKEN_HASH);

      expect(found).toBeNull();
    });
  });

  describe('revokeFamily', () => {
    it('should only revoke rows that are not already revoked', async () => {
      const delegate = createDelegate();
      delegate.updateMany.mockResolvedValue({ count: 3 });
      const repo = createRepo(delegate);

      const count = await repo.revokeFamily(FAMILY_ID, NOW);

      expect(count).toBe(3);
      expect(delegate.updateMany).toHaveBeenCalledWith({
        where: { familyId: FAMILY_ID, revokedAt: null },
        data: { revokedAt: NOW },
      });
    });
  });

  describe('revokeAllByUser', () => {
    it('should revoke every non-revoked row of the user', async () => {
      const delegate = createDelegate();
      delegate.updateMany.mockResolvedValue({ count: 5 });
      const repo = createRepo(delegate);

      const count = await repo.revokeAllByUser(USER_ID, NOW);

      expect(count).toBe(5);
      expect(delegate.updateMany).toHaveBeenCalledWith({
        where: { userId: USER_ID, revokedAt: null },
        data: { revokedAt: NOW },
      });
    });
  });

  describe('findActiveFamilies', () => {
    it('should group rows by familyId and keep the earliest createdAt', async () => {
      const delegate = createDelegate();
      delegate.findMany.mockResolvedValue([
        { familyId: 'fam-a', createdAt: new Date('2026-07-28T10:00:00.000Z') },
        { familyId: 'fam-a', createdAt: new Date('2026-07-29T10:00:00.000Z') },
        { familyId: 'fam-b', createdAt: new Date('2026-07-25T09:00:00.000Z') },
      ]);
      const repo = createRepo(delegate);

      const sessions = await repo.findActiveFamilies(USER_ID, NOW);

      expect(sessions).toEqual([
        { familyId: 'fam-a', createdAt: new Date('2026-07-28T10:00:00.000Z') },
        { familyId: 'fam-b', createdAt: new Date('2026-07-25T09:00:00.000Z') },
      ]);
    });

    it('should query only rows that are usable right now', async () => {
      const delegate = createDelegate();
      delegate.findMany.mockResolvedValue([]);
      const repo = createRepo(delegate);

      await repo.findActiveFamilies(USER_ID, NOW);

      expect(delegate.findMany).toHaveBeenCalledWith({
        where: {
          userId: USER_ID,
          usedAt: null,
          revokedAt: null,
          expiresAt: { gt: NOW },
        },
        select: { familyId: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      });
    });
  });

  describe('findFamilyOwner', () => {
    it('should return the owner userId', async () => {
      const delegate = createDelegate();
      delegate.findFirst.mockResolvedValue({ userId: USER_ID });
      const repo = createRepo(delegate);

      const owner = await repo.findFamilyOwner(FAMILY_ID);

      expect(owner).toBe(USER_ID);
    });

    it('should return null when the family does not exist', async () => {
      const delegate = createDelegate();
      delegate.findFirst.mockResolvedValue(null);
      const repo = createRepo(delegate);

      const owner = await repo.findFamilyOwner(FAMILY_ID);

      expect(owner).toBeNull();
    });
  });

  describe('save', () => {
    it('should persist the entity and return it with the generated id', async () => {
      const delegate = createDelegate();
      delegate.create.mockResolvedValue({
        id: TOKEN_ID,
        userId: USER_ID,
        tokenHash: TOKEN_HASH,
        familyId: FAMILY_ID,
        expiresAt: EXPIRES_AT,
        usedAt: null,
        revokedAt: null,
      });
      const repo = createRepo(delegate);
      const token = RefreshToken.create({
        userId: USER_ID,
        tokenHash: TOKEN_HASH,
        familyId: FAMILY_ID,
        expiresAt: EXPIRES_AT,
      });

      const saved = await repo.save(token);

      expect(saved.id).toBe(TOKEN_ID);
      expect(delegate.create).toHaveBeenCalledWith({
        data: {
          userId: USER_ID,
          tokenHash: TOKEN_HASH,
          familyId: FAMILY_ID,
          expiresAt: EXPIRES_AT,
        },
      });
    });
  });
});
