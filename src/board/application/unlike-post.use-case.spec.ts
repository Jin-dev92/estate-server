import { UnlikePostUseCase } from './unlike-post.use-case';
import { Post } from '../domain/post.entity';
import { PostCategory } from '../domain/post-category.enum';
import { PostRepository } from '../domain/post.repository';
import { PostLikeRepository } from '../domain/post-like.repository';
import { MembershipChecker } from './membership';
import {
  TransactionRunner,
  TransactionClient,
} from '../../outbox/domain/transaction-runner';
import { LikeCounter } from './like-counter';
import { LikeCountReader } from './like-count-reader';

const POST_ID = 'p1';
const BUILDING_ID = 'b1';
const USER_ID = 'u1';

const TX = {} as unknown as TransactionClient;
const txRunner: TransactionRunner = { run: (fn) => fn(TX) };

function membershipReturning(value: boolean): MembershipChecker {
  return { isMember: () => Promise.resolve(value) };
}

function postRepoWith(post: Post | null): PostRepository {
  return {
    create: (p) => Promise.resolve(p),
    findById: () => Promise.resolve(post),
    findByBuilding: () => Promise.resolve([]),
    update: (p) => Promise.resolve(p),
    delete: () => Promise.resolve(),
  };
}

function likeRepoWith(opts: { count: number; removed?: boolean }): {
  likes: PostLikeRepository;
  getLastTx: () => TransactionClient | undefined;
} {
  let lastTx: TransactionClient | undefined;
  const likes: PostLikeRepository = {
    like: () => Promise.resolve(false),
    unlike: (_p, _u, tx) => {
      lastTx = tx;
      return Promise.resolve(opts.removed ?? true);
    },
    countByPost: () => Promise.resolve(opts.count),
    countByPosts: () => Promise.resolve(new Map()),
    likedPostIds: () => Promise.resolve(new Set()),
    hasLiked: () => Promise.resolve(false),
  };
  return { likes, getLastTx: () => lastTx };
}

// decrement 호출 여부를 기록하는 카운터 스파이. fail=true면 항상 실패(best-effort 검증용).
function counterSpy(opts: { fail?: boolean } = {}) {
  const decremented: string[] = [];
  const counter: LikeCounter = {
    increment: () => Promise.resolve(),
    decrement: (postId) => {
      if (opts.fail) return Promise.reject(new Error('redis down'));
      decremented.push(postId);
      return Promise.resolve();
    },
    getMany: () => Promise.resolve(new Map()),
    backfill: () => Promise.resolve(),
  };
  return { counter, decremented };
}

function readerReturning(count: number): LikeCountReader {
  return {
    readOne: () => Promise.resolve(count),
    readMany: () => Promise.resolve(new Map()),
  } as unknown as LikeCountReader;
}

const samplePost = Post.reconstitute({
  id: POST_ID,
  buildingId: BUILDING_ID,
  authorId: 'author',
  category: PostCategory.FREE,
  title: '제목',
  content: '본문',
});

describe('UnlikePostUseCase', () => {
  it('멤버가 좋아요를 취소하면 tx로 삭제하고 갱신된 likeCount를 반환한다', async () => {
    const { likes, getLastTx } = likeRepoWith({ count: 0 });

    const useCase = new UnlikePostUseCase(
      postRepoWith(samplePost),
      likes,
      membershipReturning(true),
      txRunner,
      counterSpy().counter,
      readerReturning(0),
    );

    const result = await useCase.execute({ userId: USER_ID, postId: POST_ID });

    expect(result).toEqual({ postId: POST_ID, liked: false, likeCount: 0 });
    expect(getLastTx()).toBe(TX);
  });

  it('없는 글이면 BOARD_POST_NOT_FOUND', async () => {
    const { likes } = likeRepoWith({ count: 0 });

    const useCase = new UnlikePostUseCase(
      postRepoWith(null),
      likes,
      membershipReturning(true),
      txRunner,
      counterSpy().counter,
      readerReturning(0),
    );

    await expect(
      useCase.execute({ userId: USER_ID, postId: POST_ID }),
    ).rejects.toMatchObject({ code: 'BOARD_POST_NOT_FOUND' });
  });

  it('멤버가 아니면 BOARD_NOT_BUILDING_MEMBER', async () => {
    const { likes } = likeRepoWith({ count: 0 });

    const useCase = new UnlikePostUseCase(
      postRepoWith(samplePost),
      likes,
      membershipReturning(false),
      txRunner,
      counterSpy().counter,
      readerReturning(0),
    );

    await expect(
      useCase.execute({ userId: USER_ID, postId: POST_ID }),
    ).rejects.toMatchObject({ code: 'BOARD_NOT_BUILDING_MEMBER' });
  });

  it('실제 삭제(전이)면 커밋 후 카운터를 감소시킨다', async () => {
    const { counter, decremented } = counterSpy();
    const { likes } = likeRepoWith({ count: 0, removed: true });

    const useCase = new UnlikePostUseCase(
      postRepoWith(samplePost),
      likes,
      membershipReturning(true),
      txRunner,
      counter,
      readerReturning(0),
    );

    await useCase.execute({ userId: USER_ID, postId: POST_ID });

    expect(decremented).toEqual([POST_ID]);
  });

  it('원래 좋아요가 없었으면(전이 없음) 카운터를 건드리지 않는다', async () => {
    const { counter, decremented } = counterSpy();
    const { likes } = likeRepoWith({ count: 0, removed: false });

    const useCase = new UnlikePostUseCase(
      postRepoWith(samplePost),
      likes,
      membershipReturning(true),
      txRunner,
      counter,
      readerReturning(0),
    );

    await useCase.execute({ userId: USER_ID, postId: POST_ID });

    expect(decremented).toEqual([]);
  });

  it('카운터 감소가 실패해도 요청은 성공한다(best-effort)', async () => {
    const { counter } = counterSpy({ fail: true });
    const { likes } = likeRepoWith({ count: 0, removed: true });

    const useCase = new UnlikePostUseCase(
      postRepoWith(samplePost),
      likes,
      membershipReturning(true),
      txRunner,
      counter,
      readerReturning(0),
    );

    await expect(
      useCase.execute({ userId: USER_ID, postId: POST_ID }),
    ).resolves.toEqual({ postId: POST_ID, liked: false, likeCount: 0 });
  });
});
