import { ChatMessagePayload } from './chat-message';
import { Message } from './message.entity';

export const MESSAGE_REPOSITORY = Symbol('MESSAGE_REPOSITORY');

export interface MessageRepository {
  // 멱등 적재: 같은 messageId면 무시(P2002).
  persist(payload: ChatMessagePayload): Promise<void>;
  findRecent(roomId: string, limit: number): Promise<Message[]>;
}
