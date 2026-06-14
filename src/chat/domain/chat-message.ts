// 실시간 중계·캐시·Kafka 이벤트가 공유하는 메시지 payload.
export interface ChatMessagePayload {
  roomId: string;
  messageId: string;
  senderId: string;
  content: string;
  createdAt: string; // ISO 8601
}
