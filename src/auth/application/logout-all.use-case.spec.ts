import { RefreshTokenRepository } from '../domain/refresh-token.repository';
import { LogoutAllUseCase } from './logout-all.use-case';

const USER_ID = 'user-1';

describe('LogoutAllUseCase', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should revoke every session of the user', async () => {
    const repo = {
      revokeAllByUser: jest.fn().mockResolvedValue(3),
    } satisfies Partial<jest.Mocked<RefreshTokenRepository>>;
    const useCase = new LogoutAllUseCase(
      repo as unknown as RefreshTokenRepository,
    );

    await useCase.execute(USER_ID);

    expect(repo.revokeAllByUser).toHaveBeenCalledWith(
      USER_ID,
      expect.any(Date),
    );
  });
});
