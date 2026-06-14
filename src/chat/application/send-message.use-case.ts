import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AppException } from '../../common/errors/app-exception';
import { ChatError } from '../chat.errors';
import { Message } from '../domain/message.entity';
import { ChatMessagePayload } from '../domain/chat-message';
import {
  CHAT_ROOM_REPOSITORY,
  ChatRoomRepository,
} from '../domain/chat-room.repository';
import { MESSAGE_RELAY, MessageRelay } from '../domain/message-relay';
import { MESSAGE_CACHE, MessageCache } from '../domain/message-cache';
import { EVENT_PUBLISHER, EventPublisher } from '../../events/event-publisher';
import { EventType, EntityType } from '../../events/event-type.enum';

export interface SendMessageInput {
  userId: string;
  roomId: string;
  content: string;
}

@Injectable()
export class SendMessageUseCase {
  constructor(
    @Inject(CHAT_ROOM_REPOSITORY) private readonly rooms: ChatRoomRepository,
    @Inject(MESSAGE_RELAY) private readonly relay: MessageRelay,
    @Inject(MESSAGE_CACHE) private readonly cache: MessageCache,
    @Inject(EVENT_PUBLISHER) private readonly events: EventPublisher,
  ) {}

  async execute(input: SendMessageInput): Promise<ChatMessagePayload> {
    // ① 방 존재 확인
    const room = await this.rooms.findById(input.roomId);
    if (!room) throw new AppException(ChatError.ROOM_NOT_FOUND);

    // ② 참가자 검증 (owner 또는 tenant만 허용)
    if (!room.isParticipant(input.userId)) {
      throw new AppException(ChatError.NOT_ROOM_PARTICIPANT);
    }

    // ③ 메시지 생성 — messageId(uuid)·createdAt은 앱에서 생성(영속화 멱등 키)
    const message = Message.create({
      roomId: input.roomId,
      senderId: input.userId,
      content: input.content,
    });
    const payload: ChatMessagePayload = {
      roomId: message.roomId,
      messageId: message.id,
      senderId: message.senderId,
      content: message.content,
      createdAt: message.createdAt.toISOString(),
    };

    // ④ 실시간 중계 (WebSocket/Redis Pub-Sub 등)
    await this.relay.publish(payload);

    // ⑤ 최근 메시지 캐시 (입장 시 불러오기용)
    await this.cache.push(payload);

    // ⑥ 영속화는 Kafka 경유 — 파티션 키=roomId로 방 내 순서 보장.
    //    EventPublisher.publish() 는 절대 throw 하지 않는다(M3 보장).
    await this.events.publish({
      eventId: randomUUID(),
      eventType: EventType.MessageSent,
      occurredAt: payload.createdAt,
      actorId: input.userId,
      entityType: EntityType.Message,
      entityId: payload.roomId, // 파티션 키 = roomId
      payload,
    });

    return payload;
  }
}
