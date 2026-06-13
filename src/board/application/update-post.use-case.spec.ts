import { UpdatePostUseCase } from './update-post.use-case';
import { Post } from '../domain/post.entity';
import { PostCategory } from '../domain/post-category.enum';
import { PostRepository } from '../domain/post.repository';
import { BoardCache } from './board-cache';

const POST_ID = 'p1';
const BUILDING_ID = 'b1';
const AUTHOR_ID = 'author';

function postRepoWith(post: Post | null): PostRepository {
  return {
    create: (p) => Promise.resolve(p),
    findById: () => Promise.resolve(post),
    findByBuilding: () => Promise.resolve([]),
    update: (p) => Promise.resolve(p),
    delete: () => Promise.resolve(),
  };
}

class SpyCache implements BoardCache {
  public invalidatedDetail: string | null = null;
  public invalidatedList: string | null = null;
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
  invalidateList(buildingId: string) {
    this.invalidatedList = buildingId;
    return Promise.resolve();
  }
  invalidateDetail(postId: string) {
    this.invalidatedDetail = postId;
    return Promise.resolve();
  }
}

const ownedPost = Post.reconstitute({
  id: POST_ID,
  buildingId: BUILDING_ID,
  authorId: AUTHOR_ID,
  category: PostCategory.FREE,
  title: '원래',
  content: '원래본문',
});

describe('UpdatePostUseCase', () => {
  it('작성자가 수정하면 저장하고 상세·목록 캐시를 무효화한다', async () => {
    const cache = new SpyCache();
    const useCase = new UpdatePostUseCase(postRepoWith(ownedPost), cache);

    const updated = await useCase.execute({
      userId: AUTHOR_ID,
      postId: POST_ID,
      title: '수정',
      content: '수정본문',
    });

    expect(updated.title).toBe('수정');
    expect(cache.invalidatedDetail).toBe(POST_ID);
    expect(cache.invalidatedList).toBe(BUILDING_ID);
  });

  it('작성자가 아니면 ForbiddenException', async () => {
    const useCase = new UpdatePostUseCase(
      postRepoWith(ownedPost),
      new SpyCache(),
    );

    await expect(
      useCase.execute({
        userId: 'other',
        postId: POST_ID,
        title: 't',
        content: 'c',
      }),
    ).rejects.toMatchObject({ code: 'BOARD_NOT_AUTHOR' });
  });

  it('없는 글이면 NotFoundException', async () => {
    const useCase = new UpdatePostUseCase(postRepoWith(null), new SpyCache());

    await expect(
      useCase.execute({
        userId: AUTHOR_ID,
        postId: POST_ID,
        title: 't',
        content: 'c',
      }),
    ).rejects.toMatchObject({ code: 'BOARD_POST_NOT_FOUND' });
  });
});
