import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ConfigKey } from '../config/config-keys';
import { BoardModule } from '../board/board.module';
import { ChatController } from './interface/chat.controller';
import { ChatGateway } from './interface/chat.gateway';
import { ChatPersistenceController } from './infrastructure/chat-persistence.controller';
import { EnsureRoomUseCase } from './application/ensure-room.use-case';
import { SendMessageUseCase } from './application/send-message.use-case';
import { ListRoomsUseCase } from './application/list-rooms.use-case';
import { GetMessagesUseCase } from './application/get-messages.use-case';
import { CHAT_ROOM_REPOSITORY } from './domain/chat-room.repository';
import { MESSAGE_REPOSITORY } from './domain/message.repository';
import { MESSAGE_RELAY } from './domain/message-relay';
import { MESSAGE_CACHE } from './domain/message-cache';
import { BUILDING_REPOSITORY } from '../property/domain/building.repository';
import { PrismaChatRoomRepository } from './infrastructure/prisma-chat-room.repository';
import { PrismaMessageRepository } from './infrastructure/prisma-message.repository';
import { RedisMessageRelay } from './infrastructure/redis-message-relay';
import { RedisMessageCache } from './infrastructure/redis-message-cache';
import { PrismaBuildingRepository } from '../property/infrastructure/prisma-building.repository';

@Module({
  imports: [
    BoardModule,
    ConfigModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>(ConfigKey.JwtSecret),
      }),
    }),
  ],
  controllers: [ChatController, ChatPersistenceController],
  providers: [
    ChatGateway,
    EnsureRoomUseCase,
    SendMessageUseCase,
    ListRoomsUseCase,
    GetMessagesUseCase,
    { provide: CHAT_ROOM_REPOSITORY, useClass: PrismaChatRoomRepository },
    { provide: MESSAGE_REPOSITORY, useClass: PrismaMessageRepository },
    { provide: MESSAGE_RELAY, useClass: RedisMessageRelay },
    { provide: MESSAGE_CACHE, useClass: RedisMessageCache },
    { provide: BUILDING_REPOSITORY, useClass: PrismaBuildingRepository },
  ],
})
export class ChatModule {}
