import { ChatMessagePayload } from './chat-message';

export const MESSAGE_CACHE = Symbol('MESSAGE_CACHE');

export interface MessageCache {
  push(message: ChatMessagePayload): Promise<void>;
  getRecent(roomId: string, limit: number): Promise<ChatMessagePayload[]>;
}
