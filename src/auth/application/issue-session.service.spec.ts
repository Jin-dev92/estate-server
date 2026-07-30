import { ConfigService } from '@nestjs/config';
import { Role } from '../domain/role.enum';
import { RefreshTokenGenerator } from '../domain/refresh-token-generator';
import { RefreshTokenRepository } from '../domain/refresh-token.repository';
import { TokenIssuer } from '../domain/token-issuer';
import { RefreshToken } from '../domain/refresh-token.entity';
import { TransactionClient } from '../../outbox/domain/transaction-runner';
import { IssueSessionService } from './issue-session.service';

const USER_ID = 'user-1';
const EMAIL = 'tenant@example.com';
const RAW_TOKEN = 'raw-token';
const TOKEN_HASH = 'token-hash';
const ACCESS_TOKEN = 'access-token';
const EXISTING_FAMILY = 'family-existing';
const TTL_DAYS = 14;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_TTL_DAYS = 14;

function setup() {
  const tokenIssuer = {
    issue: jest.fn().mockResolvedValue(ACCESS_TOKEN),
  } satisfies Partial<jest.Mocked<TokenIssuer>>;

  const generator = {
    generate: jest
      .fn()
      .mockReturnValue({ token: RAW_TOKEN, tokenHash: TOKEN_HASH }),
    hash: jest.fn(),
  } satisfies Partial<jest.Mocked<RefreshTokenGenerator>>;

  const repo = {
    save: jest
      .fn<Promise<RefreshToken>, [RefreshToken, TransactionClient?]>()
      .mockImplementation((token: RefreshToken) => Promise.resolve(token)),
  } satisfies Partial<jest.Mocked<RefreshTokenRepository>>;

  const config = {
    get: jest.fn().mockReturnValue(String(TTL_DAYS)),
  } satisfies Partial<jest.Mocked<ConfigService>>;

  const service = new IssueSessionService(
    tokenIssuer,
    generator,
    repo as unknown as RefreshTokenRepository,
    config as unknown as ConfigService,
  );

  return { service, tokenIssuer, generator, repo, config };
}

describe('IssueSessionService', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('issue without familyId (login)', () => {
    it('should return both tokens', async () => {
      const { service } = setup();

      const pair = await service.issue({
        userId: USER_ID,
        email: EMAIL,
        role: Role.TENANT,
      });

      expect(pair).toEqual({
        accessToken: ACCESS_TOKEN,
        refreshToken: RAW_TOKEN,
      });
    });

    it('should put the newly created familyId into the access token payload', async () => {
      const { service, tokenIssuer, repo } = setup();

      await service.issue({
        userId: USER_ID,
        email: EMAIL,
        role: Role.TENANT,
      });

      const savedToken = repo.save.mock.calls[0][0];
      expect(tokenIssuer.issue).toHaveBeenCalledWith({
        sub: USER_ID,
        email: EMAIL,
        role: Role.TENANT,
        fam: savedToken.familyId,
      });
    });

    it('should persist only the hash, never the raw token', async () => {
      const { service, repo } = setup();

      await service.issue({
        userId: USER_ID,
        email: EMAIL,
        role: Role.TENANT,
      });

      const savedToken = repo.save.mock.calls[0][0];
      expect(savedToken.tokenHash).toBe(TOKEN_HASH);
      expect(savedToken.tokenHash).not.toBe(RAW_TOKEN);
    });
  });

  describe('issue with familyId (rotation)', () => {
    it('should keep the given familyId', async () => {
      const { service, tokenIssuer, repo } = setup();

      await service.issue(
        { userId: USER_ID, email: EMAIL, role: Role.TENANT },
        EXISTING_FAMILY,
      );

      const savedToken = repo.save.mock.calls[0][0];
      expect(savedToken.familyId).toBe(EXISTING_FAMILY);
      expect(tokenIssuer.issue).toHaveBeenCalledWith(
        expect.objectContaining({ fam: EXISTING_FAMILY }),
      );
    });
  });

  // 브리프 목록에는 없지만, tx 미전파는 "로직은 맞는데 뮤테이션엔 안 걸리는"
  // 대표 갭이다 — repo.save가 tx를 실제로 받는지, 안 주면 undefined인지를
  // 명시적으로 단정해야 tx 인자를 통째로 지워도 테스트가 잡는다.
  describe('tx propagation', () => {
    it('should pass the given tx to repository.save', async () => {
      const { service, repo } = setup();
      const tx = { marker: 'fake-tx' } as never;

      await service.issue(
        { userId: USER_ID, email: EMAIL, role: Role.TENANT },
        undefined,
        tx,
      );

      expect(repo.save.mock.calls[0][1]).toBe(tx);
    });

    it('should pass undefined to repository.save when tx is not given', async () => {
      const { service, repo } = setup();

      await service.issue({ userId: USER_ID, email: EMAIL, role: Role.TENANT });

      expect(repo.save.mock.calls[0][1]).toBeUndefined();
    });
  });

  // TTL 계산은 env 파싱 폴백(Number.isFinite && > 0)이 핵심 분기다.
  // 이 분기를 직접 검증하지 않으면 조건을 뒤집어도(예: > 0 -> < 0) 테스트가
  // 통과해버린다. 시간은 fake timer로 고정해 부동 오차 없이 ms 단위로 단정한다.
  describe('TTL calculation', () => {
    const NOW = new Date('2026-07-30T00:00:00.000Z');

    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(NOW);
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should use REFRESH_TOKEN_TTL_DAYS from env for expiresAt', async () => {
      const { service, repo, config } = setup();
      const CUSTOM_TTL_DAYS = 30;
      config.get.mockReturnValue(String(CUSTOM_TTL_DAYS));

      await service.issue({ userId: USER_ID, email: EMAIL, role: Role.TENANT });

      const savedToken = repo.save.mock.calls[0][0];
      expect(savedToken.expiresAt.getTime() - NOW.getTime()).toBe(
        CUSTOM_TTL_DAYS * MS_PER_DAY,
      );
    });

    it.each([
      ['empty string', ''],
      ['non-numeric', 'not-a-number'],
      ['zero', '0'],
      ['negative', '-5'],
    ])(
      'should fall back to the default TTL (%s)',
      async (_label, invalidRaw) => {
        const { service, repo, config } = setup();
        config.get.mockReturnValue(invalidRaw);

        await service.issue({
          userId: USER_ID,
          email: EMAIL,
          role: Role.TENANT,
        });

        const savedToken = repo.save.mock.calls[0][0];
        expect(savedToken.expiresAt.getTime() - NOW.getTime()).toBe(
          DEFAULT_TTL_DAYS * MS_PER_DAY,
        );
      },
    );
  });

  // 이 서비스가 존재하는 이유 자체를 검증한다: 리프레시 토큰을 먼저
  // 발급해 familyId를 확정한 뒤에야 액세스 토큰이 fam을 담을 수 있다.
  // 데이터 의존성(fam: saved.familyId) 테스트와 별개로, 호출 순서 자체를
  // 단정해 순서를 바꿔도(우연히 값이 맞아떨어지는 경우까지) 잡아낸다.
  describe('issuance order', () => {
    it('should call repository.save before tokenIssuer.issue', async () => {
      const { service, tokenIssuer, repo } = setup();

      await service.issue({ userId: USER_ID, email: EMAIL, role: Role.TENANT });

      const saveOrder = repo.save.mock.invocationCallOrder[0];
      const issueOrder = tokenIssuer.issue.mock.invocationCallOrder[0];
      expect(saveOrder).toBeLessThan(issueOrder);
    });
  });
});
