import { ChatMessagePayload } from './chat-message';

export const MESSAGE_RELAY = Symbol('MESSAGE_RELAY');

export interface MessageRelay {
  publish(message: ChatMessagePayload): Promise<void>;
  // 단일 채널 구독. 수신 시 handler 호출(인스턴스 부팅 시 1회).
  subscribe(handler: (message: ChatMessagePayload) => void): Promise<void>;
}
