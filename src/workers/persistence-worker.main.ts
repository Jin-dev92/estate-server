import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import * as Sentry from '@sentry/nestjs';
import { ConfigKey } from '../config/config-keys';
import { KafkaTopicInitializer } from '../events/kafka-topic-initializer';
import { initSentry } from '../common/sentry/init-sentry';
import { setupGracefulShutdown } from '../common/shutdown/graceful-shutdown';
import { PersistenceWorkerModule } from './persistence-worker.module';

// chat-events를 독립 consumer group으로 소비한다(영속화).
async function bootstrap() {
  // Sentry는 가능한 한 일찍 init(uncaughtException·unhandledRejection 자동 캡처). DSN 없으면 no-op.
  const sentryOn = initSentry({
    dsn: process.env[ConfigKey.SentryDsn] ?? '',
    environment:
      process.env[ConfigKey.SentryEnvironment] ??
      process.env.NODE_ENV ??
      'development',
    tracesSampleRate:
      Number(process.env[ConfigKey.SentryTracesSampleRate]) || 0.1,
  });
  if (sentryOn) Sentry.setTag('process', 'persistence-worker');

  const app = await NestFactory.create(PersistenceWorkerModule);
  const config = app.get(ConfigService);
  await app.get(KafkaTopicInitializer).ensureTopics();
  const microservice = app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.KAFKA,
    options: {
      client: {
        brokers: config.getOrThrow<string>(ConfigKey.KafkaBrokers).split(','),
      },
      consumer: { groupId: 'persistence-worker' },
    },
  });
  await app.startAllMicroservices();

  // 그레이스풀 셧다운(M13): 컨슈머를 먼저 닫는다 — in-flight 핸들러 완주 →
  // 오프셋 커밋 → LeaveGroup(브로커가 즉시 리밸런스, session timeout 대기 없음).
  // 이후 app.close()가 인프라(Prisma·Redis)를 정리한다. app.close()가 microservice를
  // 한 번 더 닫지만 Nest Kafka 서버는 null 가드가 있어 이중 close는 안전하다.
  const shutdownTimeoutMs =
    Number(process.env[ConfigKey.ShutdownTimeoutMs]) || 10_000;
  setupGracefulShutdown(app, {
    name: 'persistence-worker',
    timeoutMs: shutdownTimeoutMs,
    drain: async () => {
      await microservice.close();
    },
  });
  // listen() 호출하지 않음 → HTTP 포트 미바인딩(컨슈머 전용 프로세스)
}
void bootstrap();
