import { LikePostUseCase } from './like-post.use-case';
import { Post } from '../domain/post.entity';
import { PostCategory } from '../domain/post-category.enum';
import { PostRepository } from '../domain/post.repository';
import { PostLikeRepository } from '../domain/post-like.repository';
import { MembershipChecker } from './membership';
import {
  TransactionRunner,
  TransactionClient,
} from '../../outbox/domain/transaction-runner';
import { OutboxStore } from '../../outbox/domain/outbox-store';
import { EventType, EntityType } from '../../events/event-type.enum';
import { LikeCounter } from './like-counter';
import { LikeCountReader } from './like-count-reader';

const POST_ID = 'p1';
const BUILDING_ID = 'b1';
const USER_ID = 'u1';
const AUTHOR_ID = 'author';

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

// like 전이 결과·count를 제어할 수 있는 fake 좋아요 저장소
function likeRepoWith(opts: { newlyLiked: boolean; count: number }): {
  likes: PostLikeRepository;
  getLastTx: () => TransactionClient | undefined;
} {
  let lastTx: TransactionClient | undefined;
  const likes: PostLikeRepository = {
    like: (_p, _u, tx) => {
      lastTx = tx;
      return Promise.resolve(opts.newlyLiked);
    },
    unlike: () => Promise.resolve(false),
    countByPost: () => Promise.resolve(opts.count),
    countByPosts: () => Promise.resolve(new Map()),
    likedPostIds: () => Promise.resolve(new Set()),
    hasLiked: () => Promise.resolve(false),
  };
  return { likes, getLastTx: () => lastTx };
}

function outboxSpy(added: unknown[]): OutboxStore {
  return {
    add: (e) => {
      added.push(e);
      return Promise.resolve();
    },
    fetchPending: () => Promise.resolve([]),
    markPublished: () => Promise.resolve(),
    markFailed: () => Promise.resolve({ quarantined: false }),
  };
}

// increment 호출 여부를 기록하는 카운터 스파이. fail=true면 항상 실패(best-effort 검증용).
function counterSpy(opts: { fail?: boolean } = {}) {
  const incremented: string[] = [];
  const counter: LikeCounter = {
    increment: (postId) => {
      if (opts.fail) return Promise.reject(new Error('redis down'));
      incremented.push(postId);
      return Promise.resolve();
    },
    decrement: () => Promise.resolve(),
    getMany: () => Promise.resolve(new Map()),
    backfill: () => Promise.resolve(),
    remove: () => Promise.resolve(),
  };
  return { counter, incremented };
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
  authorId: AUTHOR_ID,
  category: PostCategory.FREE,
  title: '제목',
  content: '본문',
});

describe('LikePostUseCase', () => {
  it('신규 좋아요면 tx로 저장하고 outbox에 LikeCreated를 적재하며 likeCount를 반환한다', async () => {
    const added: unknown[] = [];
    const { likes, getLastTx } = likeRepoWith({ newlyLiked: true, count: 1 });

    const useCase = new LikePostUseCase(
      postRepoWith(samplePost),
      likes,
      membershipReturning(true),
      txRunner,
      outboxSpy(added),
      counterSpy().counter,
      readerReturning(1),
    );

    const result = await useCase.execute({ userId: USER_ID, postId: POST_ID });

    expect(result).toEqual({ postId: POST_ID, liked: true, likeCount: 1 });
    expect(getLastTx()).toBe(TX);
    expect(added).toEqual([
      expect.objectContaining({
        eventType: EventType.LikeCreated,
        entityType: EntityType.Post,
        entityId: POST_ID,
        actorId: USER_ID,
        payload: expect.objectContaining({
          postId: POST_ID,
          buildingId: BUILDING_ID,
        }) as object,
      }),
    ]);
  });

  it('이미 좋아요한 상태(재클릭)면 outbox에 적재하지 않는다(멱등)', async () => {
    const added: unknown[] = [];
    const { likes } = likeRepoWith({ newlyLiked: false, count: 1 });

    const useCase = new LikePostUseCase(
      postRepoWith(samplePost),
      likes,
      membershipReturning(true),
      txRunner,
      outboxSpy(added),
      counterSpy().counter,
      readerReturning(1),
    );

    const result = await useCase.execute({ userId: USER_ID, postId: POST_ID });

    expect(result).toEqual({ postId: POST_ID, liked: true, likeCount: 1 });
    expect(added).toEqual([]);
  });

  it('없는 글이면 BOARD_POST_NOT_FOUND', async () => {
    const { likes } = likeRepoWith({ newlyLiked: true, count: 0 });

    const useCase = new LikePostUseCase(
      postRepoWith(null),
      likes,
      membershipReturning(true),
      txRunner,
      outboxSpy([]),
      counterSpy().counter,
      readerReturning(0),
    );

    await expect(
      useCase.execute({ userId: USER_ID, postId: POST_ID }),
    ).rejects.toMatchObject({ code: 'BOARD_POST_NOT_FOUND' });
  });

  it('멤버가 아니면 BOARD_NOT_BUILDING_MEMBER', async () => {
    const { likes } = likeRepoWith({ newlyLiked: true, count: 0 });

    const useCase = new LikePostUseCase(
      postRepoWith(samplePost),
      likes,
      membershipReturning(false),
      txRunner,
      outboxSpy([]),
      counterSpy().counter,
      readerReturning(0),
    );

    await expect(
      useCase.execute({ userId: USER_ID, postId: POST_ID }),
    ).rejects.toMatchObject({ code: 'BOARD_NOT_BUILDING_MEMBER' });
  });

  it('신규 좋아요면 커밋 후 카운터를 증가시킨다', async () => {
    const { counter, incremented } = counterSpy();
    const { likes } = likeRepoWith({ newlyLiked: true, count: 1 });

    const useCase = new LikePostUseCase(
      postRepoWith(samplePost),
      likes,
      membershipReturning(true),
      txRunner,
      outboxSpy([]),
      counter,
      readerReturning(1),
    );

    await useCase.execute({ userId: USER_ID, postId: POST_ID });

    expect(incremented).toEqual([POST_ID]);
  });

  it('재클릭(전이 없음)이면 카운터를 건드리지 않는다', async () => {
    const { counter, incremented } = counterSpy();
    const { likes } = likeRepoWith({ newlyLiked: false, count: 1 });

    const useCase = new LikePostUseCase(
      postRepoWith(samplePost),
      likes,
      membershipReturning(true),
      txRunner,
      outboxSpy([]),
      counter,
      readerReturning(1),
    );

    await useCase.execute({ userId: USER_ID, postId: POST_ID });

    expect(incremented).toEqual([]);
  });

  it('카운터 증가가 실패해도 요청은 성공한다(best-effort)', async () => {
    const { counter } = counterSpy({ fail: true });
    const { likes } = likeRepoWith({ newlyLiked: true, count: 1 });

    const useCase = new LikePostUseCase(
      postRepoWith(samplePost),
      likes,
      membershipReturning(true),
      txRunner,
      outboxSpy([]),
      counter,
      readerReturning(1),
    );

    await expect(
      useCase.execute({ userId: USER_ID, postId: POST_ID }),
    ).resolves.toEqual({ postId: POST_ID, liked: true, likeCount: 1 });
  });
});
