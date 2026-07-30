import { RefreshToken } from '../domain/refresh-token.entity';
import { RefreshTokenGenerator } from '../domain/refresh-token-generator';
import { RefreshTokenRepository } from '../domain/refresh-token.repository';
import { LogoutUseCase } from './logout.use-case';

const USER_ID = 'user-1';
const FAMILY_ID = 'family-1';
const RAW_TOKEN = 'raw-token';
const TOKEN_HASH = 'token-hash';

function setup(found: RefreshToken | null) {
  const repo = {
    findByHash: jest.fn().mockResolvedValue(found),
    revokeFamily: jest.fn().mockResolvedValue(1),
  } satisfies Partial<jest.Mocked<RefreshTokenRepository>>;

  const generator = {
    hash: jest.fn().mockReturnValue(TOKEN_HASH),
    generate: jest.fn(),
  } satisfies Partial<jest.Mocked<RefreshTokenGenerator>>;

  const useCase = new LogoutUseCase(
    repo as unknown as RefreshTokenRepository,
    generator,
  );

  return { useCase, repo, generator };
}

describe('LogoutUseCase', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should revoke the family of the submitted token', async () => {
    const { useCase, repo } = setup(
      RefreshToken.reconstitute({
        id: 'token-1',
        userId: USER_ID,
        tokenHash: TOKEN_HASH,
        familyId: FAMILY_ID,
        expiresAt: new Date(Date.now() + 60_000),
        usedAt: null,
        revokedAt: null,
      }),
    );

    await useCase.execute(RAW_TOKEN);

    expect(repo.revokeFamily).toHaveBeenCalledWith(FAMILY_ID, expect.any(Date));
  });

  // 로그아웃은 멱등해야 한다. 알 수 없는 토큰으로 호출해도 에러를 내지 않는다
  // — 클라이언트가 이미 세션을 버린 뒤 재시도하는 경우가 정상적으로 있다.
  it('should succeed silently when the token is unknown', async () => {
    const { useCase, repo } = setup(null);

    await expect(useCase.execute(RAW_TOKEN)).resolves.toBeUndefined();

    expect(repo.revokeFamily).not.toHaveBeenCalled();
  });

  // 브리프 최소선 외 추가: setup()의 findByHash mock은 어떤 인자로 호출돼도
  // 같은 값을 반환하므로, 위 두 테스트만으로는 "원문으로 바로 조회해도" 통과한다.
  // 해시를 거치지 않고 조회하면 실서비스에서 절대 못 찾으므로 별도로 단정한다.
  it('should look up the token by its hash, not the raw value', async () => {
    const { useCase, repo, generator } = setup(null);

    await useCase.execute(RAW_TOKEN);

    expect(generator.hash).toHaveBeenCalledWith(RAW_TOKEN);
    expect(repo.findByHash).toHaveBeenCalledWith(TOKEN_HASH);
  });
});
