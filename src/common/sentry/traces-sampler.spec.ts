import { decideTraceSample } from './traces-sampler';

describe('decideTraceSample', () => {
  const RATE = 0.1;

  describe('비즈니스 외 경로일 때', () => {
    it('/docs·/docs-json는 추적하지 않는다(0)', () => {
      // Arrange
      const docs = 'GET /docs';
      const docsJson = 'GET /docs-json';

      // Act
      const docsRate = decideTraceSample(docs, RATE);
      const docsJsonRate = decideTraceSample(docsJson, RATE);

      // Assert
      expect(docsRate).toBe(0);
      expect(docsJsonRate).toBe(0);
    });

    it('/metrics는 추적하지 않는다', () => {
      // Arrange
      const transactionName = 'GET /metrics';

      // Act
      const rate = decideTraceSample(transactionName, RATE);

      // Assert
      expect(rate).toBe(0);
    });
  });

  describe('비즈니스 경로일 때', () => {
    it('기본 샘플링 비율을 쓴다', () => {
      // Arrange
      const listPosts = 'GET /buildings/abc/posts';
      const login = 'POST /auth/login';

      // Act
      const listRate = decideTraceSample(listPosts, RATE);
      const loginRate = decideTraceSample(login, RATE);

      // Assert
      expect(listRate).toBe(RATE);
      expect(loginRate).toBe(RATE);
    });
  });

  describe('트랜잭션 이름이 없을 때', () => {
    it('기본 샘플링 비율로 폴백한다', () => {
      // Arrange
      const transactionName = undefined;

      // Act
      const rate = decideTraceSample(transactionName, RATE);

      // Assert
      expect(rate).toBe(RATE);
    });
  });
});
