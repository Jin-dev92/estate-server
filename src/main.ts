import type { Server } from 'http';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { KafkaTopicInitializer } from './events/kafka-topic-initializer';
import { setupSwagger } from './common/swagger/setup-swagger';
import { initSentry } from './common/sentry/init-sentry';
import { ConfigKey } from './config/config-keys';
import { setupGracefulShutdown } from './common/shutdown/graceful-shutdown';
import { drainHttpServer } from './common/shutdown/http-drain';
import { ChatGateway } from './chat/interface/chat.gateway';
import { NotificationGateway } from './notification/interface/notification.gateway';

async function bootstrap() {
  // Sentry는 가능한 한 일찍 init(런타임·HTTP 계측이 붙도록). DSN 없으면 no-op.
  initSentry({
    dsn: process.env[ConfigKey.SentryDsn] ?? '',
    environment:
      process.env[ConfigKey.SentryEnvironment] ??
      process.env.NODE_ENV ??
      'development',
    tracesSampleRate:
      Number(process.env[ConfigKey.SentryTracesSampleRate]) || 0.1,
  });

  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  // producer가 발행할 토픽이 존재하도록 사전생성한다(auto-create off).
  // 컨슈머는 별도 워커 프로세스(src/workers/*)에서 독립 consumer group으로 구동한다.
  await app.get(KafkaTopicInitializer).ensureTopics();

  // 프로덕션에서는 전체 API 표면을 인증 없이 노출하지 않도록 /docs 를 끈다.
  if ((process.env.NODE_ENV ?? 'development') !== 'production') {
    setupSwagger(app);
  }

  await app.listen(process.env.PORT ?? 3000);

  // 그레이스풀 셧다운(M13): SIGTERM → WS 정상 disconnect + HTTP 드레인 → 인프라 정리.
  const shutdownTimeoutMs =
    Number(process.env[ConfigKey.ShutdownTimeoutMs]) || 10_000;
  const httpServer = app.getHttpServer() as Server;
  setupGracefulShutdown(app, {
    name: 'main',
    timeoutMs: shutdownTimeoutMs,
    drain: async () => {
      // WS는 장수 연결이라 자연 드레인이 안 된다 — 정상 disconnect를 보내
      // 클라이언트가 재연결 루프(socket.io 내장)를 타게 한다.
      // 채팅 메시지 영속은 Kafka 경로(persistence-worker)라 유실 없음.
      app.get(ChatGateway).server?.disconnectSockets(true);
      app.get(NotificationGateway).server?.disconnectSockets(true);
      // 예산 만료 1초 전까지 in-flight 완주를 기다리고, 이후 잔여 연결 강제 정리.
      await drainHttpServer(httpServer, shutdownTimeoutMs - 1_000);
    },
  });
}
void bootstrap();
