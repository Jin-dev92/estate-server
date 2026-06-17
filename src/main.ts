import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { KafkaTopicInitializer } from './events/kafka-topic-initializer';
import { setupSwagger } from './common/swagger/setup-swagger';
import { initSentry } from './common/sentry/init-sentry';
import { ConfigKey } from './config/config-keys';

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
}
void bootstrap();
