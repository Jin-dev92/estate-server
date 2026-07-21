import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import * as Sentry from '@sentry/nestjs';
import { ConfigKey } from '../config/config-keys';
import { ConsumerGroup } from '../events/consumer-groups';
import { KafkaTopicInitializer } from '../events/kafka-topic-initializer';
import { initSentry } from '../common/sentry/init-sentry';
import {
  setupGracefulShutdown,
  getShutdownTimeoutMs,
} from '../common/shutdown/graceful-shutdown';
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
  const microservice = app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.KAFKA,
    options: {
      client: {
        brokers: config.getOrThrow<string>(ConfigKey.KafkaBrokers).split(','),
      },
      consumer: { groupId: ConsumerGroup.Audit },
    },
  });
  await app.startAllMicroservices();

  // 그레이스풀 셧다운(M13): 컨슈머를 먼저 닫는다 — in-flight 핸들러 완주 →
  // 오프셋 커밋 → LeaveGroup(브로커가 즉시 리밸런스, session timeout 대기 없음).
  // 이후 app.close()가 인프라(Prisma·Redis)를 정리한다. app.close()가 microservice를
  // 한 번 더 닫지만 Nest Kafka 서버는 null 가드가 있어 이중 close는 안전하다
  // (검증 버전 @nestjs/microservices@11.1.26 — server-kafka.js close()의 consumer/producer
  //  null 가드에 의존. 버전업 시 이 가정이 깨지면 배포마다 exit 1로 눈에 띄게 실패한다).
  const shutdownTimeoutMs = getShutdownTimeoutMs();
  setupGracefulShutdown(app, {
    name: 'audit-worker',
    timeoutMs: shutdownTimeoutMs,
    drain: async () => {
      await microservice.close();
    },
  });
  // listen() 호출하지 않음 → HTTP 포트 미바인딩(컨슈머 전용 프로세스)
}
void bootstrap();
