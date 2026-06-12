import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { GetPostUseCase } from './get-post.use-case';
import { Post } from '../domain/post.entity';
import { PostCategory } from '../domain/post-category.enum';
import { PostRepository } from '../domain/post.repository';
import { CommentRepository } from '../domain/comment.repository';
import { Comment } from '../domain/comment.entity';
import { BoardCache, PostDetail } from './board-cache';
import { MembershipChecker } from './membership';

const POST_ID = 'p1';
const BUILDING_ID = 'b1';
const USER_ID = 'u1';

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
    );

    const detail = await useCase.execute({ userId: USER_ID, postId: POST_ID });

    expect(detail.id).toBe(POST_ID);
    expect(detail.comments).toHaveLength(1);
    expect(cache.setDetailCalls).toBe(1);
  });

  it('없는 글이면 NotFoundException', async () => {
    const useCase = new GetPostUseCase(
      postRepoWith(null),
      commentRepo,
      new FakeCache(),
      membershipReturning(true),
    );

    await expect(
      useCase.execute({ userId: USER_ID, postId: POST_ID }),
    ).rejects.toThrow(NotFoundException);
  });

  it('멤버가 아니면 ForbiddenException', async () => {
    const useCase = new GetPostUseCase(
      postRepoWith(samplePost),
      commentRepo,
      new FakeCache(),
      membershipReturning(false),
    );

    await expect(
      useCase.execute({ userId: USER_ID, postId: POST_ID }),
    ).rejects.toThrow(ForbiddenException);
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
    );

    await expect(
      useCase.execute({ userId: USER_ID, postId: POST_ID }),
    ).rejects.toThrow(ForbiddenException);
  });
});
