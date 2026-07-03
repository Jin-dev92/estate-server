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
    );

    await expect(
      useCase.execute({ userId: USER_ID, postId: POST_ID }),
    ).rejects.toMatchObject({ code: 'BOARD_NOT_BUILDING_MEMBER' });
  });
});
