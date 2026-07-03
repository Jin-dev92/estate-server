import { PrismaPostLikeRepository } from './prisma-post-like.repository';
import { PrismaService } from '../../prisma/prisma.service';

const POST_ID = 'p1';
const USER_ID = 'u1';

// PrismaService는 거대 생성 타입이라 필요한 postLike 메서드만 mock한다.
function createMockPrisma() {
  return {
    postLike: {
      createMany: jest.fn(),
      deleteMany: jest.fn(),
      count: jest.fn(),
      groupBy: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
    },
  };
}

describe('PrismaPostLikeRepository', () => {
  let prisma: ReturnType<typeof createMockPrisma>;
  let repo: PrismaPostLikeRepository;

  beforeEach(() => {
    prisma = createMockPrisma();
    repo = new PrismaPostLikeRepository(prisma as unknown as PrismaService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('like', () => {
    it('신규 좋아요면 createMany(skipDuplicates)로 넣고 true를 반환한다', async () => {
      prisma.postLike.createMany.mockResolvedValue({ count: 1 });

      const result = await repo.like(POST_ID, USER_ID);

      expect(prisma.postLike.createMany).toHaveBeenCalledWith({
        data: [{ postId: POST_ID, userId: USER_ID }],
        skipDuplicates: true,
      });
      expect(result).toBe(true);
    });

    it('이미 좋아요한 상태면 count 0 → false를 반환한다', async () => {
      prisma.postLike.createMany.mockResolvedValue({ count: 0 });

      const result = await repo.like(POST_ID, USER_ID);

      expect(result).toBe(false);
    });
  });

  describe('unlike', () => {
    it('삭제된 행이 있으면 true를 반환한다', async () => {
      prisma.postLike.deleteMany.mockResolvedValue({ count: 1 });

      const result = await repo.unlike(POST_ID, USER_ID);

      expect(prisma.postLike.deleteMany).toHaveBeenCalledWith({
        where: { postId: POST_ID, userId: USER_ID },
      });
      expect(result).toBe(true);
    });

    it('삭제할 행이 없으면 false를 반환한다', async () => {
      prisma.postLike.deleteMany.mockResolvedValue({ count: 0 });

      const result = await repo.unlike(POST_ID, USER_ID);

      expect(result).toBe(false);
    });
  });

  describe('countByPost', () => {
    it('해당 글의 좋아요 수를 COUNT로 조회한다', async () => {
      prisma.postLike.count.mockResolvedValue(3);

      const result = await repo.countByPost(POST_ID);

      expect(prisma.postLike.count).toHaveBeenCalledWith({
        where: { postId: POST_ID },
      });
      expect(result).toBe(3);
    });
  });

  describe('countByPosts', () => {
    it('빈 배열이면 쿼리 없이 빈 맵', async () => {
      const result = await repo.countByPosts([]);

      expect(prisma.postLike.groupBy).not.toHaveBeenCalled();
      expect(result.size).toBe(0);
    });

    it('groupBy 결과를 postId→count 맵으로 변환한다', async () => {
      prisma.postLike.groupBy.mockResolvedValue([
        { postId: 'p1', _count: { _all: 2 } },
        { postId: 'p2', _count: { _all: 5 } },
      ]);

      const result = await repo.countByPosts(['p1', 'p2', 'p3']);

      expect(result.get('p1')).toBe(2);
      expect(result.get('p2')).toBe(5);
      expect(result.has('p3')).toBe(false);
    });
  });

  describe('likedPostIds', () => {
    it('빈 배열이면 쿼리 없이 빈 셋', async () => {
      const result = await repo.likedPostIds(USER_ID, []);

      expect(prisma.postLike.findMany).not.toHaveBeenCalled();
      expect(result.size).toBe(0);
    });

    it('유저가 좋아요한 postId 집합을 반환한다', async () => {
      prisma.postLike.findMany.mockResolvedValue([{ postId: 'p1' }]);

      const result = await repo.likedPostIds(USER_ID, ['p1', 'p2']);

      expect(prisma.postLike.findMany).toHaveBeenCalledWith({
        where: { userId: USER_ID, postId: { in: ['p1', 'p2'] } },
        select: { postId: true },
      });
      expect(result.has('p1')).toBe(true);
      expect(result.has('p2')).toBe(false);
    });
  });

  describe('hasLiked', () => {
    it('행이 있으면 true', async () => {
      prisma.postLike.findUnique.mockResolvedValue({ id: 'l1' });

      const result = await repo.hasLiked(POST_ID, USER_ID);

      expect(prisma.postLike.findUnique).toHaveBeenCalledWith({
        where: { postId_userId: { postId: POST_ID, userId: USER_ID } },
        select: { id: true },
      });
      expect(result).toBe(true);
    });

    it('행이 없으면 false', async () => {
      prisma.postLike.findUnique.mockResolvedValue(null);

      const result = await repo.hasLiked(POST_ID, USER_ID);

      expect(result).toBe(false);
    });
  });
});
