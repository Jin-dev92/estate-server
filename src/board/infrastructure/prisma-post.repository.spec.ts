import { PrismaPostRepository } from './prisma-post.repository';
import { PrismaService } from '../../prisma/prisma.service';
import { Post } from '../domain/post.entity';
import { PostCategory } from '../domain/post-category.enum';

const POST_ID = 'p1';
const BUILDING_ID = 'b1';
const AUTHOR_ID = 'author';

// PrismaService는 거대 생성 타입이라 필요한 모델 메서드만 mock한다.
// (테스트 한정) as unknown as PrismaService 로 주입한다 — as any 금지 규칙 준수.
function createMockPrisma() {
  return {
    post: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    comment: {
      updateMany: jest.fn(),
    },
    // 전달된 작업 배열을 그대로 실행해주는 단순 트랜잭션 mock
    $transaction: jest.fn((ops: unknown[]) =>
      Promise.all(ops as Promise<unknown>[]),
    ),
  };
}

function rowOf(post: Partial<{ id: string }> = {}) {
  return {
    id: POST_ID,
    buildingId: BUILDING_ID,
    authorId: AUTHOR_ID,
    category: PostCategory.FREE,
    title: '제목',
    content: '본문',
    ...post,
  };
}

describe('PrismaPostRepository', () => {
  let prisma: ReturnType<typeof createMockPrisma>;
  let repo: PrismaPostRepository;

  beforeEach(() => {
    prisma = createMockPrisma();
    repo = new PrismaPostRepository(prisma as unknown as PrismaService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('findById', () => {
    it('deletedAt이 null인 글만 findFirst로 조회한다', async () => {
      prisma.post.findFirst.mockResolvedValue(rowOf());

      const found = await repo.findById(POST_ID);

      expect(prisma.post.findFirst).toHaveBeenCalledWith({
        where: { id: POST_ID, deletedAt: null },
      });
      expect(found).toBeInstanceOf(Post);
    });
  });

  describe('findByBuilding', () => {
    it('deletedAt이 null인 글만 조회한다', async () => {
      prisma.post.findMany.mockResolvedValue([rowOf()]);

      await repo.findByBuilding(BUILDING_ID);

      expect(prisma.post.findMany).toHaveBeenCalledWith({
        where: { buildingId: BUILDING_ID, deletedAt: null },
        orderBy: { createdAt: 'desc' },
      });
    });
  });

  describe('delete', () => {
    it('Post와 살아있는 Comment를 한 트랜잭션에서 soft delete한다', async () => {
      await repo.delete(POST_ID);

      expect(prisma.comment.updateMany).toHaveBeenCalledWith({
        where: { postId: POST_ID, deletedAt: null },
        data: { deletedAt: expect.any(Date) },
      });
      expect(prisma.post.update).toHaveBeenCalledWith({
        where: { id: POST_ID },
        data: { deletedAt: expect.any(Date) },
      });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });
  });
});
