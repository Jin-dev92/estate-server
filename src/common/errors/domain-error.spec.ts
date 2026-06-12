import { DomainError } from './domain-error';

describe('DomainError', () => {
  it('code 미지정 시 기본값은 VALIDATION_FAILED', () => {
    const err = new DomainError('제목은 필수입니다.');

    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('VALIDATION_FAILED');
    expect(err.message).toBe('제목은 필수입니다.');
  });

  it('code를 명시하면 그 값을 가진다', () => {
    const err = new DomainError('x', 'CUSTOM');

    expect(err.code).toBe('CUSTOM');
  });
});
