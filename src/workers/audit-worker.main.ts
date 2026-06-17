import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import * as Sentry from '@sentry/nestjs';
import { ConfigKey } from '../config/config-keys';
import { KafkaTopicInitializer } from '../events/kafka-topic-initializer';
import { initSentry } from '../common/sentry/init-sentry';
import { AuditWorkerModule } from './audit-worker.module';

// chat·board·membership 전체를 독립 consumer group으로 소비한다(감사).
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
  if (sentryOn) Sentry.setTag('process', 'audit-worker');

  const app = await NestFactory.create(AuditWorkerModule);
  const config = app.get(ConfigService);
  await app.get(KafkaTopicInitializer).ensureTopics();
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.KAFKA,
    options: {
      client: {
        brokers: config.getOrThrow<string>(ConfigKey.KafkaBrokers).split(','),
      },
      consumer: { groupId: 'audit-worker' },
    },
  });
  await app.startAllMicroservices();
  // listen() 호출하지 않음 → HTTP 포트 미바인딩(컨슈머 전용 프로세스)
}
void bootstrap();
