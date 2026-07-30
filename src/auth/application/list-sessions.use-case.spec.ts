import { RefreshTokenRepository } from '../domain/refresh-token.repository';
import { ListSessionsUseCase } from './list-sessions.use-case';

const USER_ID = 'user-1';
const FAMILY_A = 'family-a';
const FAMILY_B = 'family-b';
const CREATED_A = new Date('2026-07-28T10:00:00.000Z');
const CREATED_B = new Date('2026-07-25T09:00:00.000Z');

function setup() {
  const repo = {
    findActiveFamilies: jest.fn().mockResolvedValue([
      { familyId: FAMILY_A, createdAt: CREATED_A },
      { familyId: FAMILY_B, createdAt: CREATED_B },
    ]),
  } satisfies Partial<jest.Mocked<RefreshTokenRepository>>;

  const useCase = new ListSessionsUseCase(
    repo as unknown as RefreshTokenRepository,
  );

  return { useCase, repo };
}

describe('ListSessionsUseCase', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should mark only the requesting family as current', async () => {
    const { useCase } = setup();

    const sessions = await useCase.execute(USER_ID, FAMILY_A);

    expect(sessions).toEqual([
      { familyId: FAMILY_A, createdAt: CREATED_A, current: true },
      { familyId: FAMILY_B, createdAt: CREATED_B, current: false },
    ]);
  });

  // 배포 시점에 이미 발급된 액세스 토큰에는 fam 클레임이 없다.
  // 예외를 던지지 않고 전부 false로 둔다 — 최대 15분 뒤 자연히 해소된다.
  it('should mark nothing as current when fam claim is missing', async () => {
    const { useCase } = setup();

    const sessions = await useCase.execute(USER_ID, undefined);

    expect(sessions.every((s) => s.current === false)).toBe(true);
  });

  // 뮤테이션 자문: 위 두 테스트는 repo가 반환하는 고정 배열만 검증하므로,
  // findActiveFamilies에 잘못된 인자(userId 누락·순서 뒤바뀜 등)를 넘겨도
  // 잡아내지 못한다. 호출 인자 자체를 검증해 이를 메운다.
  it('should query active families with the requesting user id and current time', async () => {
    const { useCase, repo } = setup();

    await useCase.execute(USER_ID, FAMILY_A);

    expect(repo.findActiveFamilies).toHaveBeenCalledWith(
      USER_ID,
      expect.any(Date),
    );
  });
});
