import { CreatePostUseCase } from './create-post.use-case';
import { Post } from '../domain/post.entity';
import { PostCategory } from '../domain/post-category.enum';
import { PostRepository } from '../domain/post.repository';
import { BoardCache } from './board-cache';
import { MembershipChecker } from './membership';
import { EventPublisher } from '../../events/event-publisher';
import { EventType, EntityType } from '../../events/event-type.enum';

const USER_ID = 'u1';
const BUILDING_ID = 'b1';
const POST_ID = 'p1';

function deps(isMember: boolean) {
  const saved = Post.reconstitute({
    id: POST_ID,
    buildingId: BUILDING_ID,
    authorId: USER_ID,
    category: PostCategory.FREE,
    title: '제목',
    content: '본문',
  });
  const posts: PostRepository = {
    create: () => Promise.resolve(saved),
    findById: () => Promise.resolve(null),
    findByBuilding: () => Promise.resolve([]),
    update: (p) => Promise.resolve(p),
    delete: () => Promise.resolve(),
  };
  const cache: Partial<BoardCache> = { invalidateList: () => Promise.resolve() };
  const membership: MembershipChecker = { isMember: () => Promise.resolve(isMember) };
  const published: unknown[] = [];
  const events: EventPublisher = {
    publish: (e) => {
      published.push(e);
      return Promise.resolve();
    },
  };
  return { posts, cache, membership, events, published };
}

describe('CreatePostUseCase', () => {
  it('멤버가 작성하면 PostCreated 이벤트를 발행한다', async () => {
    const { posts, cache, membership, events, published } = deps(true);
    const useCase = new CreatePostUseCase(posts, cache as BoardCache, membership, events);

    await useCase.execute({ userId: USER_ID, buildingId: BUILDING_ID, title: '제목', content: '본문' });

    expect(published).toEqual([
      expect.objectContaining({
        eventType: EventType.PostCreated,
        entityType: EntityType.Post,
        entityId: POST_ID,
        actorId: USER_ID,
        payload: expect.objectContaining({ buildingId: BUILDING_ID }),
      }),
    ]);
  });

  it('멤버가 아니면 NOT_BUILDING_MEMBER로 거부하고 발행하지 않는다', async () => {
    const { posts, cache, membership, events, published } = deps(false);
    const useCase = new CreatePostUseCase(posts, cache as BoardCache, membership, events);

    await expect(
      useCase.execute({ userId: USER_ID, buildingId: BUILDING_ID, title: 't', content: 'c' }),
    ).rejects.toMatchObject({ code: 'BOARD_NOT_BUILDING_MEMBER' });
    expect(published).toEqual([]);
  });
});
