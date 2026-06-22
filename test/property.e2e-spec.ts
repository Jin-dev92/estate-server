import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Property (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const ownerEmail = `owner_${Date.now()}@test.com`;
  const tenantEmail = `tenant_${Date.now()}@test.com`;
  let ownerToken: string;
  let tenantToken: string;

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
    await app.init();

    await signup(ownerEmail);
    await signup(tenantEmail);
    // OWNER 승격(프로비저닝은 M1 범위 밖) — role을 바꾼 뒤 로그인해야 JWT에 반영됨
    await prisma.user.update({
      where: { email: ownerEmail },
      data: { role: 'OWNER' },
    });
    ownerToken = await login(ownerEmail);
    tenantToken = await login(tenantEmail);
  });

  afterAll(async () => {
    // FK 순서: Lease → Unit → Building → User
    const owner = await prisma.user.findUnique({
      where: { email: ownerEmail },
    });
    if (owner) {
      const buildings = await prisma.building.findMany({
        where: { ownerId: owner.id },
        select: { id: true },
      });
      const buildingIds = buildings.map((b) => b.id);
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
      where: { email: { in: [ownerEmail, tenantEmail] } },
    });
    await app.close();
  });

  it('건물주: 건물→호실→초대코드 발급, 입주자: 코드로 가입→호실 자동 연결', async () => {
    const building = await request(app.getHttpServer() as App)
      .post('/buildings')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: '래미안', address: '서울시 강남구' })
      .expect(201);
    const buildingId = (building.body as { id: string }).id;

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
    expect(typeof code).toBe('string');

    await request(app.getHttpServer() as App)
      .post('/invite-codes/redeem')
      .set('Authorization', `Bearer ${tenantToken}`)
      .send({ code })
      .expect(201)
      .expect((res) =>
        expect((res.body as { unitId: string }).unitId).toBe(unitId),
      );

    // 입주자의 Lease에 해당 호실이 연결됐는지 확인 (자동 연결 검증)
    await request(app.getHttpServer() as App)
      .get('/me/leases')
      .set('Authorization', `Bearer ${tenantToken}`)
      .expect(200)
      .expect((res) => {
        const leases = res.body as Array<{ unitId: string; status: string }>;
        expect(leases.some((l) => l.unitId === unitId)).toBe(true);
      });
  });

  it('입주자(TENANT)가 건물 생성 시도 → 403 (RBAC)', async () => {
    await request(app.getHttpServer() as App)
      .post('/buildings')
      .set('Authorization', `Bearer ${tenantToken}`)
      .send({ name: '무단', address: '주소' })
      .expect(403);
  });

  it('발급된 초대코드는 미인증으로 미리보기되고 소비되지 않는다', async () => {
    // 선행: 건물·호실 생성 후 code 발급
    const building = await request(app.getHttpServer() as App)
      .post('/buildings')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: '미리보기 테스트 건물', address: '서울시 종로구' })
      .expect(201);
    const buildingId = (building.body as { id: string }).id;

    const unit = await request(app.getHttpServer() as App)
      .post(`/buildings/${buildingId}/units`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: '202호', floor: 2 })
      .expect(201);
    const unitId = (unit.body as { id: string }).id;

    const invite = await request(app.getHttpServer() as App)
      .post(`/units/${unitId}/invite-codes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(201);
    const code = (invite.body as { code: string }).code;

    // 미인증 미리보기: valid=true + 이름
    const preview = await request(app.getHttpServer() as App)
      .get(`/invite-codes/${code}/preview`)
      .expect(200);
    expect((preview.body as { valid: boolean }).valid).toBe(true);
    expect((preview.body as { unitName?: string }).unitName).toBeDefined();

    // 비소비 검증: 미리보기 후에도 실제 redeem(입주)이 성공해야 함
    await request(app.getHttpServer() as App)
      .post('/invite-codes/redeem')
      .set('Authorization', `Bearer ${tenantToken}`)
      .send({ code })
      .expect(201);
  });

  it('잘못된 코드 미리보기는 valid=false', async () => {
    const res = await request(app.getHttpServer() as App)
      .get('/invite-codes/NOPE_INVALID/preview')
      .expect(200);
    expect((res.body as { valid: boolean }).valid).toBe(false);
  });

  it('이미 사용된/없는 초대코드 redeem → 404 (단일 사용·만료 불구분)', async () => {
    await request(app.getHttpServer() as App)
      .post('/invite-codes/redeem')
      .set('Authorization', `Bearer ${tenantToken}`)
      .send({ code: 'definitely-not-a-real-code' })
      .expect(404);
  });

  it('다른 소유자의 건물에 호실 생성 시도 → 403 (소유권 검사)', async () => {
    const owner = await prisma.user.findUnique({
      where: { email: ownerEmail },
    });
    const someBuilding = await prisma.building.findFirst({
      where: { ownerId: owner!.id },
      select: { id: true },
    });
    await prisma.user.update({
      where: { email: tenantEmail },
      data: { role: 'OWNER' },
    });
    const elevatedTenantToken = await login(tenantEmail);

    await request(app.getHttpServer() as App)
      .post(`/buildings/${someBuilding!.id}/units`)
      .set('Authorization', `Bearer ${elevatedTenantToken}`)
      .send({ name: '침입호', floor: 9 })
      .expect(403);

    // 원복
    await prisma.user.update({
      where: { email: tenantEmail },
      data: { role: 'TENANT' },
    });
  });
});
