import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Error handling (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const email = `errtest_${Date.now()}@test.com`;

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
    await prisma.user.deleteMany({ where: { email } });
    await app.close();
  });

  it('잘못된 로그인 → 401 + code AUTH_INVALID_CREDENTIALS 봉투', async () => {
    await request(app.getHttpServer() as App)
      .post('/auth/login')
      .send({ email: 'nobody@test.com', password: 'pw123456' })
      .expect(401)
      .expect((res) => {
        const body = res.body as Record<string, unknown>;
        expect(body.statusCode).toBe(401);
        expect(body.code).toBe('AUTH_INVALID_CREDENTIALS');
        expect(typeof body.message).toBe('string');
        expect(typeof body.path).toBe('string');
        expect(typeof body.timestamp).toBe('string');
      });
  });

  it('DTO 검증 실패(짧은 비밀번호) → 400 + COMMON_VALIDATION_FAILED', async () => {
    await request(app.getHttpServer() as App)
      .post('/auth/signup')
      .send({ email, name: 'x', password: 'short' })
      .expect(400)
      .expect((res) =>
        expect((res.body as { code: string }).code).toBe(
          'COMMON_VALIDATION_FAILED',
        ),
      );
  });

  it('토큰 없이 보호 엔드포인트 → 401 봉투', async () => {
    await request(app.getHttpServer() as App)
      .get('/auth/me')
      .expect(401)
      .expect((res) =>
        expect((res.body as { statusCode: number }).statusCode).toBe(401),
      );
  });
});
