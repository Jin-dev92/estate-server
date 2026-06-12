import { BcryptPasswordHasher } from './bcrypt-password-hasher';

describe('BcryptPasswordHasher', () => {
  const hasher = new BcryptPasswordHasher();

  it('hash한 값은 원문과 다르고 compare로 검증된다', async () => {
    const hash = await hasher.hash('secret123');
    expect(hash).not.toBe('secret123');
    expect(await hasher.compare('secret123', hash)).toBe(true);
    expect(await hasher.compare('wrong', hash)).toBe(false);
  });
});
