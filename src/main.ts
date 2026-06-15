import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { KafkaTopicInitializer } from './events/kafka-topic-initializer';
import { setupSwagger } from './common/swagger/setup-swagger';

async function bootstrap() {
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
