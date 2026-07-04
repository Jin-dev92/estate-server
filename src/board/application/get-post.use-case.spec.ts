import { GetPostUseCase } from './get-post.use-case';
import { Post } from '../domain/post.entity';
import { PostCategory } from '../domain/post-category.enum';
import { PostRepository } from '../domain/post.repository';
import { CommentRepository } from '../domain/comment.repository';
import { Comment } from '../domain/comment.entity';
import { BoardCache, PostDetail } from './board-cache';
import { MembershipChecker } from './membership';
import { PostLikeRepository } from '../domain/post-like.repository';
import { LikeCountReader } from './like-count-reader';

const POST_ID = 'p1';
const BUILDING_ID = 'b1';
const USER_ID = 'u1';

function membershipReturning(value: boolean): MembershipChecker {
  return { isMember: () => Promise.resolve(value) };
}

// count는 이제 LikeCountReader가 담당 — 이 fake는 liked(hasLiked)만 신경쓴다.
function likeRepoWith(opts: { liked: boolean }): PostLikeRepository {
  return {
    like: () => Promise.resolve(false),
    unlike: () => Promise.resolve(false),
    countByPost: () => Promise.resolve(0),
    countByPosts: () => Promise.resolve(new Map()),
    likedPostIds: () => Promise.resolve(new Set()),
    hasLiked: () => Promise.resolve(opts.liked),
  };
}

function readerReturning(count: number): LikeCountReader {
  return {
    readOne: () => Promise.resolve(count),
    readMany: () => Promise.resolve(new Map()),
  } as unknown as LikeCountReader;
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

const commentRepo: CommentRepository = {
  create: (c) => Promise.resolve(c),
  findByPost: () =>
    Promise.resolve([
      Comment.reconstitute({
        id: 'c1',
        postId: POST_ID,
        authorId: 'u2',
        content: '댓글',
      }),
    ]),
};

class FakeCache implements BoardCache {
  public detail: PostDetail | null = null;
  public setDetailCalls = 0;
  getList() {
    return Promise.resolve(null);
  }
  setList() {
    return Promise.resolve();
  }
  getDetail() {
    return Promise.resolve(this.detail);
  }
  setDetail(_p: string, detail: PostDetail) {
    this.setDetailCalls += 1;
    this.detail = detail;
    return Promise.resolve();
  }
  invalidateList() {
    return Promise.resolve();
  }
  invalidateDetail() {
    return Promise.resolve();
  }
}

const samplePost = Post.reconstitute({
  id: POST_ID,
  buildingId: BUILDING_ID,
  authorId: USER_ID,
  category: PostCategory.FREE,
  title: '제목',
  content: '본문',
});

describe('GetPostUseCase', () => {
  it('캐시 miss면 글+댓글을 모아 상세를 만들고 캐시에 채운다', async () => {
    const cache = new FakeCache();
    const useCase = new GetPostUseCase(
      postRepoWith(samplePost),
      commentRepo,
      cache,
      membershipReturning(true),
      likeRepoWith({ liked: true }),
      readerReturning(2),
    );

    const detail = await useCase.execute({ userId: USER_ID, postId: POST_ID });

    expect(detail.id).toBe(POST_ID);
    expect(detail.comments).toHaveLength(1);
    expect(cache.setDetailCalls).toBe(1);
    expect(detail.likeCount).toBe(2);
    expect(detail.likedByMe).toBe(true);
  });

  it('없는 글이면 NotFoundException', async () => {
    const useCase = new GetPostUseCase(
      postRepoWith(null),
      commentRepo,
      new FakeCache(),
      membershipReturning(true),
      likeRepoWith({ liked: false }),
      readerReturning(0),
    );

    await expect(
      useCase.execute({ userId: USER_ID, postId: POST_ID }),
    ).rejects.toMatchObject({ code: 'BOARD_POST_NOT_FOUND' });
  });

  it('멤버가 아니면 ForbiddenException', async () => {
    const useCase = new GetPostUseCase(
      postRepoWith(samplePost),
      commentRepo,
      new FakeCache(),
      membershipReturning(false),
      likeRepoWith({ liked: false }),
      readerReturning(0),
    );

    await expect(
      useCase.execute({ userId: USER_ID, postId: POST_ID }),
    ).rejects.toMatchObject({ code: 'BOARD_NOT_BUILDING_MEMBER' });
  });

  it('캐시 hit이어도 멤버가 아니면 ForbiddenException', async () => {
    const cache = new FakeCache();
    cache.detail = {
      id: POST_ID,
      buildingId: BUILDING_ID,
      category: PostCategory.FREE,
      title: '제목',
      content: '본문',
      authorId: USER_ID,
      comments: [],
    };
    const useCase = new GetPostUseCase(
      postRepoWith(samplePost),
      commentRepo,
      cache,
      membershipReturning(false),
      likeRepoWith({ liked: false }),
      readerReturning(0),
    );

    await expect(
      useCase.execute({ userId: USER_ID, postId: POST_ID }),
    ).rejects.toMatchObject({ code: 'BOARD_NOT_BUILDING_MEMBER' });
  });

  it('캐시 hit이어도 좋아요 정보(likeCount·likedByMe)를 라이브로 병합한다', async () => {
    const cache = new FakeCache();
    cache.detail = {
      id: POST_ID,
      buildingId: BUILDING_ID,
      category: PostCategory.FREE,
      title: '제목',
      content: '본문',
      authorId: USER_ID,
      comments: [],
    };
    const useCase = new GetPostUseCase(
      postRepoWith(samplePost),
      commentRepo,
      cache,
      membershipReturning(true),
      likeRepoWith({ liked: false }),
      readerReturning(5),
    );

    const detail = await useCase.execute({ userId: USER_ID, postId: POST_ID });

    expect(detail.likeCount).toBe(5);
    expect(detail.likedByMe).toBe(false);
    expect(cache.setDetailCalls).toBe(0); // 캐시 hit이라 재적재 없음
  });
});
