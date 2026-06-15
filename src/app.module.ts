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

@Module({
  imports: [
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
  ],
  providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
})
export class AppModule {}
