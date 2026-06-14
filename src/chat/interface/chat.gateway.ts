import { Inject, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { ConfigKey } from '../../config/config-keys';
import { TokenPayload } from '../../auth/domain/token-issuer';
import { SendMessageUseCase } from '../application/send-message.use-case';
import {
  CHAT_ROOM_REPOSITORY,
  ChatRoomRepository,
} from '../domain/chat-room.repository';
import { MESSAGE_RELAY, MessageRelay } from '../domain/message-relay';

// WS는 transport만: 인증(handleConnection)·방 join·send 라우팅. 로직은 유스케이스.
@WebSocketGateway({ cors: true })
export class ChatGateway implements OnGatewayConnection, OnModuleInit {
  private readonly logger = new Logger(ChatGateway.name);
  @WebSocketServer() server!: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly sendMessage: SendMessageUseCase,
    @Inject(CHAT_ROOM_REPOSITORY) private readonly rooms: ChatRoomRepository,
    @Inject(MESSAGE_RELAY) private readonly relay: MessageRelay,
  ) {}

  // 인스턴스 부팅 시 1회: Redis 단일 채널 수신 → 해당 room의 로컬 소켓에 emit.
  async onModuleInit(): Promise<void> {
    await this.relay.subscribe((message) => {
      this.server.to(message.roomId).emit('message', message);
    });
  }

  // 핸드셰이크 JWT 검증. 실패 시 연결 거부.
  handleConnection(client: Socket): void {
    try {
      const token = (client.handshake.auth?.token ?? '') as string;
      const payload = this.jwt.verify<TokenPayload>(token, {
        secret: this.config.getOrThrow<string>(ConfigKey.JwtSecret),
      });
      (client.data as { userId?: string }).userId = payload.sub;
    } catch {
      client.disconnect();
    }
  }

  @SubscribeMessage('join')
  async onJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { roomId: string },
  ): Promise<void> {
    const userId = (client.data as { userId?: string }).userId;
    const room = userId ? await this.rooms.findById(body.roomId) : null;
    if (!room || !userId || !room.isParticipant(userId)) {
      client.emit('error', { code: 'CHAT_NOT_ROOM_PARTICIPANT' });
      return;
    }
    await client.join(body.roomId);
  }

  @SubscribeMessage('message')
  async onMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { roomId: string; content: string },
  ): Promise<void> {
    const userId = (client.data as { userId?: string }).userId;
    if (!userId) return;
    try {
      await this.sendMessage.execute({
        userId,
        roomId: body.roomId,
        content: body.content,
      });
    } catch (err) {
      client.emit('error', { message: (err as Error).message });
    }
  }
}
