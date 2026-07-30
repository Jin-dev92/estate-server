import { AppException } from '../../common/errors/app-exception';
import { RefreshTokenRepository } from '../domain/refresh-token.repository';
import { RevokeSessionUseCase } from './revoke-session.use-case';

const USER_ID = 'user-1';
const OTHER_USER_ID = 'user-2';
const FAMILY_ID = 'family-1';

function setup(owner: string | null) {
  const repo = {
    findFamilyOwner: jest.fn().mockResolvedValue(owner),
    revokeFamily: jest.fn().mockResolvedValue(1),
  } satisfies Partial<jest.Mocked<RefreshTokenRepository>>;

  const useCase = new RevokeSessionUseCase(
    repo as unknown as RefreshTokenRepository,
  );

  return { useCase, repo };
}

describe('RevokeSessionUseCase', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should revoke the family when the requester owns it', async () => {
    const { useCase, repo } = setup(USER_ID);

    await useCase.execute(USER_ID, FAMILY_ID);

    expect(repo.revokeFamily).toHaveBeenCalledWith(FAMILY_ID, expect.any(Date));
  });

  it('should reject revoking a family owned by someone else', async () => {
    const { useCase, repo } = setup(OTHER_USER_ID);
    expect.assertions(2);

    try {
      await useCase.execute(USER_ID, FAMILY_ID);
    } catch (e) {
      expect((e as AppException).code).toBe('AUTH_NOT_SESSION_OWNER');
    }

    expect(repo.revokeFamily).not.toHaveBeenCalled();
  });

  // 404로 구분하면 남의 familyId 존재 여부를 알려주는 정보 노출이 된다.
  it('should reject an unknown familyId with the same error as a foreign one', async () => {
    const { useCase, repo } = setup(null);
    expect.assertions(2);

    try {
      await useCase.execute(USER_ID, FAMILY_ID);
    } catch (e) {
      expect((e as AppException).code).toBe('AUTH_NOT_SESSION_OWNER');
    }

    expect(repo.revokeFamily).not.toHaveBeenCalled();
  });

  // 뮤테이션 자문: 위 테스트들은 findFamilyOwner를 호출했는지만 확인하고
  // 어떤 familyId로 호출했는지는 보지 않는다. 다른 인자(예: userId)로
  // 잘못 조회해도 mock이 owner를 그대로 반환하므로 통과해버린다.
  it('should look up the owner of the requested family', async () => {
    const { useCase, repo } = setup(USER_ID);

    await useCase.execute(USER_ID, FAMILY_ID);

    expect(repo.findFamilyOwner).toHaveBeenCalledWith(FAMILY_ID);
  });
});
