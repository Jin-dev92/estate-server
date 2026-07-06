import { LikeCountReader } from './like-count-reader';
import { LikeCounter } from './like-counter';
import { PostLikeRepository } from '../domain/post-like.repository';

function counterWith(hits: Map<string, number>) {
  const backfilled: Map<string, number>[] = [];
  const counter: LikeCounter = {
    increment: () => Promise.resolve(),
    decrement: () => Promise.resolve(),
    getMany: () => Promise.resolve(hits),
    backfill: (entries) => {
      backfilled.push(entries);
      return Promise.resolve();
    },
    remove: () => Promise.resolve(),
  };
  return { counter, backfilled };
}

function likeRepoCounting(counts: Map<string, number>) {
  const calls: string[][] = [];
  const likes: PostLikeRepository = {
    like: () => Promise.resolve(false),
    unlike: () => Promise.resolve(false),
    countByPost: () => Promise.resolve(0),
    countByPosts: (ids) => {
      calls.push(ids);
      return Promise.resolve(counts);
    },
    likedPostIds: () => Promise.resolve(new Set()),
    hasLiked: () => Promise.resolve(false),
  };
  return { likes, calls };
}

describe('LikeCountReader', () => {
  it('전량 카운터 적중이면 DB를 호출하지 않고 백필도 없다', async () => {
    const { counter, backfilled } = counterWith(
      new Map([
        ['p1', 3],
        ['p2', 5],
      ]),
    );
    const { likes, calls } = likeRepoCounting(new Map());
    const reader = new LikeCountReader(counter, likes);

    const result = await reader.readMany(['p1', 'p2']);

    expect(result.get('p1')).toBe(3);
    expect(result.get('p2')).toBe(5);
    expect(calls).toHaveLength(0);
    expect(backfilled).toHaveLength(0);
  });

  it('미스만 DB로 집계하고, 0 보정 포함해 백필한 뒤 병합해 반환한다', async () => {
    // p1은 적중, p2·p3 미스. DB엔 p2만 좋아요 존재(p3은 0개 → countByPosts 결과에 없음).
    const { counter, backfilled } = counterWith(new Map([['p1', 3]]));
    const { likes, calls } = likeRepoCounting(new Map([['p2', 7]]));
    const reader = new LikeCountReader(counter, likes);

    const result = await reader.readMany(['p1', 'p2', 'p3']);

    expect(calls).toEqual([['p2', 'p3']]); // 미스만 DB 집계
    expect(backfilled).toEqual([
      new Map([
        ['p2', 7],
        ['p3', 0], // 0도 백필해야 다음 조회가 카운터에 적중
      ]),
    ]);
    expect(result.get('p1')).toBe(3);
    expect(result.get('p2')).toBe(7);
    expect(result.get('p3')).toBe(0);
  });

  it('빈 입력이면 아무것도 호출하지 않는다', async () => {
    const { counter, backfilled } = counterWith(new Map());
    const { likes, calls } = likeRepoCounting(new Map());
    const reader = new LikeCountReader(counter, likes);

    const result = await reader.readMany([]);

    expect(result.size).toBe(0);
    expect(calls).toHaveLength(0);
    expect(backfilled).toHaveLength(0);
  });

  it('readOne은 단건을 숫자로 돌려준다(미스면 재구축값)', async () => {
    const { counter } = counterWith(new Map());
    const { likes } = likeRepoCounting(new Map([['p1', 4]]));
    const reader = new LikeCountReader(counter, likes);

    await expect(reader.readOne('p1')).resolves.toBe(4);
  });
});
