import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { AuthModule } from './auth/auth.module';
import { PropertyModule } from './property/property.module';
import { BoardModule } from './board/board.module';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter';
import { KafkaModule } from './events/kafka.module';
import { AuditModule } from './audit/audit.module';
import { ChatModule } from './chat/chat.module';
import { NotificationModule } from './notification/notification.module';
import { RateLimitModule } from './common/rate-limit/rate-limit.module';

@Module({
  imports: [
    // Sentry는 main.ts 부트스트랩의 initSentry()로 초기화한다(@sentry/nestjs v10은
    // 별도 모듈 없이 init의 nestIntegration/httpIntegration이 자동 계측).
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    RedisModule,
    AuthModule,
    PropertyModule,
    BoardModule,
    KafkaModule,
    AuditModule,
    ChatModule,
    NotificationModule,
    RateLimitModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
})
export class AppModule {}
