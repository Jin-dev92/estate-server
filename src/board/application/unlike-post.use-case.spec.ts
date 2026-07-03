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

function likeRepoWith(count: number): {
  likes: PostLikeRepository;
  getLastTx: () => TransactionClient | undefined;
} {
  let lastTx: TransactionClient | undefined;
  const likes: PostLikeRepository = {
    like: () => Promise.resolve(false),
    unlike: (_p, _u, tx) => {
      lastTx = tx;
      return Promise.resolve(true);
    },
    countByPost: () => Promise.resolve(count),
    countByPosts: () => Promise.resolve(new Map()),
    likedPostIds: () => Promise.resolve(new Set()),
    hasLiked: () => Promise.resolve(false),
  };
  return { likes, getLastTx: () => lastTx };
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
    const { likes, getLastTx } = likeRepoWith(0);

    const useCase = new UnlikePostUseCase(
      postRepoWith(samplePost),
      likes,
      membershipReturning(true),
      txRunner,
    );

    const result = await useCase.execute({ userId: USER_ID, postId: POST_ID });

    expect(result).toEqual({ postId: POST_ID, liked: false, likeCount: 0 });
    expect(getLastTx()).toBe(TX);
  });

  it('없는 글이면 BOARD_POST_NOT_FOUND', async () => {
    const { likes } = likeRepoWith(0);

    const useCase = new UnlikePostUseCase(
      postRepoWith(null),
      likes,
      membershipReturning(true),
      txRunner,
    );

    await expect(
      useCase.execute({ userId: USER_ID, postId: POST_ID }),
    ).rejects.toMatchObject({ code: 'BOARD_POST_NOT_FOUND' });
  });

  it('멤버가 아니면 BOARD_NOT_BUILDING_MEMBER', async () => {
    const { likes } = likeRepoWith(0);

    const useCase = new UnlikePostUseCase(
      postRepoWith(samplePost),
      likes,
      membershipReturning(false),
      txRunner,
    );

    await expect(
      useCase.execute({ userId: USER_ID, postId: POST_ID }),
    ).rejects.toMatchObject({ code: 'BOARD_NOT_BUILDING_MEMBER' });
  });
});
