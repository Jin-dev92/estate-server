import { DeletePostUseCase } from './delete-post.use-case';
import { Post } from '../domain/post.entity';
import { PostCategory } from '../domain/post-category.enum';
import { PostRepository } from '../domain/post.repository';
import { BoardCache } from './board-cache';

const POST_ID = 'p1';
const BUILDING_ID = 'b1';
const AUTHOR_ID = 'author';

const ownedPost = Post.reconstitute({
  id: POST_ID,
  buildingId: BUILDING_ID,
  authorId: AUTHOR_ID,
  category: PostCategory.FREE,
  title: '제목',
  content: '본문',
});

// 삭제 호출을 기록하는 mock repository
function postRepoWith(post: Post | null) {
  const deleted: string[] = [];
  const repo: PostRepository = {
    create: (p) => Promise.resolve(p),
    findById: () => Promise.resolve(post),
    findByBuilding: () => Promise.resolve([]),
    update: (p) => Promise.resolve(p),
    delete: (id) => {
      deleted.push(id);
      return Promise.resolve();
    },
  };
  return { repo, deleted };
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

describe('DeletePostUseCase', () => {
  it('작성자가 삭제하면 repository.delete 호출 후 상세·목록 캐시를 무효화한다', async () => {
    const { repo, deleted } = postRepoWith(ownedPost);
    const cache = new SpyCache();
    const useCase = new DeletePostUseCase(repo, cache);

    await useCase.execute({ userId: AUTHOR_ID, postId: POST_ID });

    expect(deleted).toEqual([POST_ID]);
    expect(cache.invalidatedDetail).toBe(POST_ID);
    expect(cache.invalidatedList).toBe(BUILDING_ID);
  });

  it('작성자가 아니면 BOARD_NOT_AUTHOR로 거부하고 삭제하지 않는다', async () => {
    const { repo, deleted } = postRepoWith(ownedPost);
    const useCase = new DeletePostUseCase(repo, new SpyCache());

    await expect(
      useCase.execute({ userId: 'other', postId: POST_ID }),
    ).rejects.toMatchObject({ code: 'BOARD_NOT_AUTHOR' });
    expect(deleted).toEqual([]);
  });

  it('없는 글이면 BOARD_POST_NOT_FOUND', async () => {
    const { repo } = postRepoWith(null);
    const useCase = new DeletePostUseCase(repo, new SpyCache());

    await expect(
      useCase.execute({ userId: AUTHOR_ID, postId: POST_ID }),
    ).rejects.toMatchObject({ code: 'BOARD_POST_NOT_FOUND' });
  });
});
