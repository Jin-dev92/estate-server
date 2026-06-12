import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';

describe('Board (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: RedisService;

  const ownerEmail = `bowner_${Date.now()}@test.com`;
  const tenantEmail = `btenant_${Date.now()}@test.com`;
  const outsiderEmail = `bout_${Date.now()}@test.com`;
  let ownerToken: string;
  let tenantToken: string;
  let outsiderToken: string;
  let buildingId: string;

  async function signup(email: string): Promise<void> {
    await request(app.getHttpServer() as App)
      .post('/auth/signup')
      .send({ email, name: '사용자', password: 'pw123456' })
      .expect(201);
  }
  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer() as App)
      .post('/auth/login')
      .send({ email, password: 'pw123456' })
      .expect(201);
    return (res.body as { accessToken: string }).accessToken;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    prisma = app.get(PrismaService);
    redis = app.get(RedisService);
    await app.init();

    await signup(ownerEmail);
    await signup(tenantEmail);
    await signup(outsiderEmail);
    await prisma.user.update({
      where: { email: ownerEmail },
      data: { role: 'OWNER' },
    });
    ownerToken = await login(ownerEmail);
    tenantToken = await login(tenantEmail);
    outsiderToken = await login(outsiderEmail);

    const building = await request(app.getHttpServer() as App)
      .post('/buildings')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: '래미안', address: '서울' })
      .expect(201);
    buildingId = (building.body as { id: string }).id;

    const unit = await request(app.getHttpServer() as App)
      .post(`/buildings/${buildingId}/units`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: '101호', floor: 1 })
      .expect(201);
    const unitId = (unit.body as { id: string }).id;

    const invite = await request(app.getHttpServer() as App)
      .post(`/units/${unitId}/invite-codes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(201);
    const code = (invite.body as { code: string }).code;

    await request(app.getHttpServer() as App)
      .post('/invite-codes/redeem')
      .set('Authorization', `Bearer ${tenantToken}`)
      .send({ code })
      .expect(201);
  });

  afterAll(async () => {
    const owner = await prisma.user.findUnique({
      where: { email: ownerEmail },
    });
    if (owner) {
      const buildings = await prisma.building.findMany({
        where: { ownerId: owner.id },
        select: { id: true },
      });
      const buildingIds = buildings.map((b) => b.id);
      const posts = await prisma.post.findMany({
        where: { buildingId: { in: buildingIds } },
        select: { id: true },
      });
      const postIds = posts.map((p) => p.id);
      await prisma.comment.deleteMany({ where: { postId: { in: postIds } } });
      await prisma.post.deleteMany({ where: { id: { in: postIds } } });
      const units = await prisma.unit.findMany({
        where: { buildingId: { in: buildingIds } },
        select: { id: true },
      });
      const unitIds = units.map((u) => u.id);
      await prisma.lease.deleteMany({ where: { unitId: { in: unitIds } } });
      await prisma.unit.deleteMany({ where: { id: { in: unitIds } } });
      await prisma.building.deleteMany({ where: { id: { in: buildingIds } } });
    }
    await prisma.user.deleteMany({
      where: { email: { in: [ownerEmail, tenantEmail, outsiderEmail] } },
    });
    await app.close();
  });

  it('멤버가 글 작성→목록(캐시 set)→새 글 작성 시 목록 캐시 무효화', async () => {
    const created = await request(app.getHttpServer() as App)
      .post(`/buildings/${buildingId}/posts`)
      .set('Authorization', `Bearer ${tenantToken}`)
      .send({ title: '첫 글', content: '본문' })
      .expect(201);
    const postId = (created.body as { id: string }).id;
    expect(typeof postId).toBe('string');

    await request(app.getHttpServer() as App)
      .get(`/buildings/${buildingId}/posts`)
      .set('Authorization', `Bearer ${tenantToken}`)
      .expect(200)
      .expect((res) =>
        expect((res.body as unknown[]).length).toBeGreaterThan(0),
      );

    expect(await redis.exists(`board:list:${buildingId}`)).toBe(1);

    await request(app.getHttpServer() as App)
      .post(`/buildings/${buildingId}/posts`)
      .set('Authorization', `Bearer ${tenantToken}`)
      .send({ title: '둘째 글', content: '본문2' })
      .expect(201);
    expect(await redis.exists(`board:list:${buildingId}`)).toBe(0);
  });

  it('상세 GET(캐시 set) 후 댓글 작성 시 상세 캐시 무효화', async () => {
    const created = await request(app.getHttpServer() as App)
      .post(`/buildings/${buildingId}/posts`)
      .set('Authorization', `Bearer ${tenantToken}`)
      .send({ title: '댓글대상', content: '본문' })
      .expect(201);
    const postId = (created.body as { id: string }).id;

    await request(app.getHttpServer() as App)
      .get(`/posts/${postId}`)
      .set('Authorization', `Bearer ${tenantToken}`)
      .expect(200);
    expect(await redis.exists(`board:detail:${postId}`)).toBe(1);

    await request(app.getHttpServer() as App)
      .post(`/posts/${postId}/comments`)
      .set('Authorization', `Bearer ${tenantToken}`)
      .send({ content: '첫 댓글' })
      .expect(201);
    expect(await redis.exists(`board:detail:${postId}`)).toBe(0);

    await request(app.getHttpServer() as App)
      .get(`/posts/${postId}`)
      .set('Authorization', `Bearer ${tenantToken}`)
      .expect(200)
      .expect((res) => {
        const body = res.body as { comments: unknown[] };
        expect(body.comments.length).toBe(1);
      });
  });

  it('비멤버(outsider)는 목록 조회·작성 모두 403', async () => {
    await request(app.getHttpServer() as App)
      .get(`/buildings/${buildingId}/posts`)
      .set('Authorization', `Bearer ${outsiderToken}`)
      .expect(403);

    await request(app.getHttpServer() as App)
      .post(`/buildings/${buildingId}/posts`)
      .set('Authorization', `Bearer ${outsiderToken}`)
      .send({ title: '무단', content: '본문' })
      .expect(403);
  });

  it('작성자가 아닌 멤버는 수정 403, 작성자는 수정 200', async () => {
    const created = await request(app.getHttpServer() as App)
      .post(`/buildings/${buildingId}/posts`)
      .set('Authorization', `Bearer ${tenantToken}`)
      .send({ title: '소유글', content: '본문' })
      .expect(201);
    const postId = (created.body as { id: string }).id;

    await request(app.getHttpServer() as App)
      .patch(`/posts/${postId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ title: '침범', content: 'x' })
      .expect(403);

    await request(app.getHttpServer() as App)
      .patch(`/posts/${postId}`)
      .set('Authorization', `Bearer ${tenantToken}`)
      .send({ title: '수정됨', content: '수정본문' })
      .expect(200)
      .expect((res) =>
        expect((res.body as { title: string }).title).toBe('수정됨'),
      );
  });
});
