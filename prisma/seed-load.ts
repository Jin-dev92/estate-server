// 부하테스트용 고정 데이터 시드(멱등). 앱과 동일한 bcrypt rounds=10으로 해시해야 로그인 가능.
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

// 부하 스크립트(load/lib/auth.js)와 공유하는 고정 자격증명.
const LOAD_EMAIL = 'load-owner@example.com';
const LOAD_PASSWORD = 'load-test-1234';
const BUILDING_NAME = 'LoadTest Tower';

// 부하 볼륨 파라미터(멱등: 이미 있으면 부족분만 채움).
const SEED_POST_COUNT = Number(process.env.SEED_POST_COUNT ?? 5);
const SEED_LIKES_PER_POST = Number(process.env.SEED_LIKES_PER_POST ?? 0);

async function main(): Promise<void> {
  const passwordHash = await bcrypt.hash(LOAD_PASSWORD, 10);

  // OWNER 유저 upsert(이미 있으면 role·해시 보정).
  const owner = await prisma.user.upsert({
    where: { email: LOAD_EMAIL },
    update: { role: 'OWNER', passwordHash, deletedAt: null },
    create: {
      email: LOAD_EMAIL,
      name: 'Load Owner',
      passwordHash,
      role: 'OWNER',
    },
  });

  // 건물: 이름으로 조회해 없으면 생성(고정 1개).
  let building = await prisma.building.findFirst({
    where: { name: BUILDING_NAME, ownerId: owner.id },
  });
  building ??= await prisma.building.create({
    data: { ownerId: owner.id, name: BUILDING_NAME, address: 'Seoul' },
  });

  // 읽기 시나리오용 글 채우기(부족분만 생성).
  const existing = await prisma.post.count({
    where: { buildingId: building.id },
  });
  for (let i = existing; i < SEED_POST_COUNT; i++) {
    await prisma.post.create({
      data: {
        buildingId: building.id,
        authorId: owner.id,
        category: 'FREE',
        title: `부하테스트 글 ${i + 1}`,
        content: '시드 데이터',
      },
    });
  }

  // 좋아요 시드: 유니크(postId,userId) 제약 때문에 liker 유저가 좋아요 수만큼 필요하다.
  // 유저·좋아요 모두 createMany(skipDuplicates)로 멱등 — 볼륨을 늘려 재실행하면 부족분만 추가된다.
  if (SEED_LIKES_PER_POST > 0) {
    const likerEmails = Array.from(
      { length: SEED_LIKES_PER_POST },
      (_, i) => `load-liker-${i}@example.com`,
    );
    await prisma.user.createMany({
      data: likerEmails.map((email, i) => ({
        email,
        name: `Load Liker ${i}`,
        role: 'TENANT',
      })),
      skipDuplicates: true,
    });
    const likers = await prisma.user.findMany({
      where: { email: { in: likerEmails } },
      select: { id: true },
    });
    const posts = await prisma.post.findMany({
      where: { buildingId: building.id },
      select: { id: true },
    });
    // 글 단위 배치(글 50 × 2000이면 호출 50번 × 2000행) — 단일 초대형 INSERT 회피.
    for (const post of posts) {
      await prisma.postLike.createMany({
        data: likers.map((u) => ({ postId: post.id, userId: u.id })),
        skipDuplicates: true,
      });
    }
  }

  console.log(
    JSON.stringify(
      {
        email: LOAD_EMAIL,
        password: LOAD_PASSWORD,
        buildingId: building.id,
        posts: Math.max(existing, SEED_POST_COUNT),
        likesPerPost: SEED_LIKES_PER_POST,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
