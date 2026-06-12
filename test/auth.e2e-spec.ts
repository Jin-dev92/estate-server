import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Auth (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const email = `e2e_${Date.now()}@test.com`;
  const dupEmail = `dup_${Date.now()}@test.com`;

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
  });

  afterAll(async () => {
    await prisma.user.deleteMany({
      where: { email: { in: [email, dupEmail] } },
    });
    await app.close();
  });

  it('signup → login → me 전체 흐름', async () => {
    await request(app.getHttpServer() as App)
      .post('/auth/signup')
      .send({ email, name: '길동', password: 'pw123456' })
      .expect(201)
      .expect((res) =>
        expect((res.body as { role: string }).role).toBe('TENANT'),
      );

    const login = await request(app.getHttpServer() as App)
      .post('/auth/login')
      .send({ email, password: 'pw123456' })
      .expect(201);
    const token = (login.body as { accessToken: string }).accessToken;
    expect(typeof token).toBe('string');

    await request(app.getHttpServer() as App)
      .get('/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
      .expect((res) =>
        expect((res.body as { email: string }).email).toBe(email),
      );
  });

  it('토큰 없이 /auth/me는 401', async () => {
    await request(app.getHttpServer() as App)
      .get('/auth/me')
      .expect(401);
  });

  it('짧은 비밀번호 signup은 400', async () => {
    await request(app.getHttpServer() as App)
      .post('/auth/signup')
      .send({
        email: `short_${Date.now()}@test.com`,
        name: 'x',
        password: 'short',
      })
      .expect(400);
  });

  it('이미 가입된 이메일로 다시 signup하면 409', async () => {
    await request(app.getHttpServer() as App)
      .post('/auth/signup')
      .send({ email: dupEmail, name: '길동', password: 'pw123456' })
      .expect(201);

    await request(app.getHttpServer() as App)
      .post('/auth/signup')
      .send({ email: dupEmail, name: '철수', password: 'pw123456' })
      .expect(409);
  });
});
