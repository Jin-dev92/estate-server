import { CreateCommentUseCase } from './create-comment.use-case';
import { Post } from '../domain/post.entity';
import { PostCategory } from '../domain/post-category.enum';
import { Comment } from '../domain/comment.entity';
import { PostRepository } from '../domain/post.repository';
import { CommentRepository } from '../domain/comment.repository';
import { BoardCache } from './board-cache';
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
  create: (c) =>
    Promise.resolve(
      Comment.reconstitute({
        id: 'c-generated',
        postId: c.postId,
        authorId: c.authorId,
        content: c.content,
      }),
    ),
  findByPost: () => Promise.resolve([]),
};

class SpyCache implements BoardCache {
  public invalidatedDetail: string | null = null;
  getList() {
    return Promise.resolve(null);
  }
  setList() {
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
  invalidateDetail(postId: string) {
    this.invalidatedDetail = postId;
    return Promise.resolve();
  }
}

const samplePost = Post.reconstitute({
  id: POST_ID,
  buildingId: BUILDING_ID,
  authorId: 'author',
  category: PostCategory.FREE,
  title: '제목',
  content: '본문',
});

describe('CreateCommentUseCase', () => {
  it('멤버가 댓글을 달면 저장하고 상세 캐시를 무효화한다', async () => {
    const cache = new SpyCache();
    const useCase = new CreateCommentUseCase(
      commentRepo,
      postRepoWith(samplePost),
      cache,
      membershipReturning(true),
    );

    const comment = await useCase.execute({
      userId: USER_ID,
      postId: POST_ID,
      content: '댓글',
    });

    expect(comment.id).toBe('c-generated');
    expect(cache.invalidatedDetail).toBe(POST_ID);
  });

  it('없는 글이면 NotFoundException', async () => {
    const useCase = new CreateCommentUseCase(
      commentRepo,
      postRepoWith(null),
      new SpyCache(),
      membershipReturning(true),
    );

    await expect(
      useCase.execute({ userId: USER_ID, postId: POST_ID, content: '댓글' }),
    ).rejects.toMatchObject({ code: 'BOARD_POST_NOT_FOUND' });
  });

  it('멤버가 아니면 ForbiddenException', async () => {
    const useCase = new CreateCommentUseCase(
      commentRepo,
      postRepoWith(samplePost),
      new SpyCache(),
      membershipReturning(false),
    );

    await expect(
      useCase.execute({ userId: USER_ID, postId: POST_ID, content: '댓글' }),
    ).rejects.toMatchObject({ code: 'BOARD_NOT_BUILDING_MEMBER' });
  });
});
