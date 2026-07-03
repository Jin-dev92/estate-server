import { ListPostsUseCase } from './list-posts.use-case';
import { Post } from '../domain/post.entity';
import { PostCategory } from '../domain/post-category.enum';
import { PostRepository } from '../domain/post.repository';
import { BoardCache, PostSummary } from './board-cache';
import { MembershipChecker } from './membership';
import { PostLikeRepository } from '../domain/post-like.repository';

const BUILDING_ID = 'b1';
const USER_ID = 'u1';

function membershipReturning(value: boolean): MembershipChecker {
  return { isMember: () => Promise.resolve(value) };
}

function likeRepoWith(opts: {
  counts: Map<string, number>;
  liked: Set<string>;
}): PostLikeRepository {
  return {
    like: () => Promise.resolve(false),
    unlike: () => Promise.resolve(false),
    countByPost: () => Promise.resolve(0),
    countByPosts: () => Promise.resolve(opts.counts),
    likedPostIds: () => Promise.resolve(opts.liked),
    hasLiked: () => Promise.resolve(false),
  };
}

const samplePost = Post.reconstitute({
  id: 'p1',
  buildingId: BUILDING_ID,
  authorId: USER_ID,
  category: PostCategory.FREE,
  title: '제목',
  content: '본문',
});

function repoWithPosts(posts: Post[]): PostRepository {
  return {
    create: (p) => Promise.resolve(p),
    findById: () => Promise.resolve(null),
    findByBuilding: () => Promise.resolve(posts),
    update: (p) => Promise.resolve(p),
    delete: () => Promise.resolve(),
  };
}

class FakeCache implements BoardCache {
  public list: PostSummary[] | null = null;
  public setListCalls = 0;
  getList() {
    return Promise.resolve(this.list);
  }
  setList(_b: string, posts: PostSummary[]) {
    this.setListCalls += 1;
    this.list = posts;
    return Promise.resolve();
  }
  getDetail() {
    return Promise.resolve(null);
  }
  setDetail() {
    return Promise.resolve();
  }
  invalidateList() {
    return Promise.resolve();
  }
  invalidateDetail() {
    return Promise.resolve();
  }
}

describe('ListPostsUseCase', () => {
  it('캐시 miss면 repo를 조회하고 캐시에 채운다', async () => {
    const cache = new FakeCache();
    const repo = repoWithPosts([samplePost]);
    const useCase = new ListPostsUseCase(
      repo,
      cache,
      membershipReturning(true),
      likeRepoWith({ counts: new Map([['p1', 4]]), liked: new Set(['p1']) }),
    );

    const result = await useCase.execute({
      userId: USER_ID,
      buildingId: BUILDING_ID,
    });

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('p1');
    expect(cache.setListCalls).toBe(1);
    expect(result[0].likeCount).toBe(4);
    expect(result[0].likedByMe).toBe(true);
  });

  it('캐시 hit이면 repo를 건너뛰고 캐시 값을 반환한다', async () => {
    const cache = new FakeCache();
    cache.list = [
      { id: 'cached', category: PostCategory.FREE, title: 'c', authorId: 'x' },
    ];
    const repo = repoWithPosts([samplePost]);
    const findSpy = jest.spyOn(repo, 'findByBuilding');
    const useCase = new ListPostsUseCase(
      repo,
      cache,
      membershipReturning(true),
      likeRepoWith({ counts: new Map([['cached', 2]]), liked: new Set() }),
    );

    const result = await useCase.execute({
      userId: USER_ID,
      buildingId: BUILDING_ID,
    });

    expect(result[0].id).toBe('cached');
    expect(findSpy).not.toHaveBeenCalled();
    expect(result[0].likeCount).toBe(2);
    expect(result[0].likedByMe).toBe(false);
  });

  it('멤버가 아니면 ForbiddenException', async () => {
    const useCase = new ListPostsUseCase(
      repoWithPosts([]),
      new FakeCache(),
      membershipReturning(false),
      likeRepoWith({ counts: new Map(), liked: new Set() }),
    );

    await expect(
      useCase.execute({ userId: USER_ID, buildingId: BUILDING_ID }),
    ).rejects.toMatchObject({ code: 'BOARD_NOT_BUILDING_MEMBER' });
  });
});
