import { CONSUMER_GROUPS, ConsumerGroup } from './consumer-groups';

describe('ConsumerGroup', () => {
  describe('워커와 lag collector가 그룹 목록을 공유할 때', () => {
    it('세 consumer group의 브로커 식별자를 고정한다', () => {
      // Arrange
      const expected = [
        'persistence-worker',
        'audit-worker',
        'notification-worker',
      ];

      // Act
      const groups = [...CONSUMER_GROUPS];

      // Assert
      expect(ConsumerGroup.Persistence).toBe('persistence-worker');
      expect(ConsumerGroup.Audit).toBe('audit-worker');
      expect(ConsumerGroup.Notification).toBe('notification-worker');
      expect(groups).toStrictEqual(expected);
    });
  });
});
