import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { ConfigKey } from '../config/config-keys';
import { OutboxModule } from '../outbox/outbox.module';
import { RelayOutboxUseCase } from '../outbox/application/relay-outbox.use-case';
import { initSentry } from '../common/sentry/init-sentry';
import { RelayLoop } from './relay-loop';
import { setupGracefulShutdown } from '../common/shutdown/graceful-shutdown';

// outbox-relay: PENDING outbox를 주기 폴링해 Kafka로 발행한다(별도 프로세스).
// HTTP/consumer 없는 순수 백그라운드 워커라 application context만 띄운다.
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
  if (sentryOn) Sentry.setTag('process', 'outbox-relay');

  const app = await NestFactory.createApplicationContext(OutboxModule);
  const logger = new Logger('OutboxRelay');
  const config = app.get(ConfigService);
  const relay = app.get(RelayOutboxUseCase);
  const pollMs = Number(config.get<string>(ConfigKey.OutboxPollMs)) || 1000;

  logger.log(`outbox-relay 시작(폴링 ${pollMs}ms)`);

  const loop = new RelayLoop(() => relay.execute(), pollMs);
  loop.start();

  // 그레이스풀 셧다운(M13): 진행 중 틱 완주 → 인프라 정리 → 종료.
  const shutdownTimeoutMs =
    Number(process.env[ConfigKey.ShutdownTimeoutMs]) || 10_000;
  setupGracefulShutdown(app, {
    name: 'outbox-relay',
    timeoutMs: shutdownTimeoutMs,
    drain: () => loop.stop(),
  });
}

void bootstrap();
