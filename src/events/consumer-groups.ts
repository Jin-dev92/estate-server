export const ConsumerGroup = {
  Persistence: 'persistence-worker',
  Audit: 'audit-worker',
  Notification: 'notification-worker',
} as const;

export type ConsumerGroupId =
  (typeof ConsumerGroup)[keyof typeof ConsumerGroup];

export const CONSUMER_GROUPS: readonly ConsumerGroupId[] = [
  ConsumerGroup.Persistence,
  ConsumerGroup.Audit,
  ConsumerGroup.Notification,
];
