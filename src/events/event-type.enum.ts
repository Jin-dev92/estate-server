// 도메인 이벤트 종류. 매직스트링 금지 — 발행·소비·매핑이 이 enum을 단일 출처로 참조한다.
export const enum EventType {
  PostCreated = 'PostCreated',
  CommentCreated = 'CommentCreated',
  TenantJoined = 'TenantJoined',
  LeaseEnded = 'LeaseEnded',
  MessageSent = 'MessageSent',
}

// 이벤트가 가리키는 엔티티 종류(AuditLog.entityType).
export const enum EntityType {
  Post = 'Post',
  Comment = 'Comment',
  Lease = 'Lease',
  Message = 'Message',
}

// Kafka 토픽 = 바운디드 컨텍스트 경계.
export const enum KafkaTopic {
  BoardEvents = 'board-events',
  MembershipEvents = 'membership-events',
  ChatEvents = 'chat-events',
}
