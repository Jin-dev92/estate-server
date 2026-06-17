import { ArgumentsHost, HttpStatus, NotFoundException } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { AppException } from './app-exception';
import { DomainError } from './domain-error';

jest.mock('@sentry/nestjs');

function mockHost(
  url = '/x',
  method = 'GET',
  user?: { sub: string; role: string },
): {
  host: ArgumentsHost;
  status: jest.Mock;
  json: jest.Mock;
} {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({ url, method, user }),
    }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

describe('AllExceptionsFilter', () => {
  const filter = new AllExceptionsFilter();

  afterEach(() => jest.clearAllMocks());

  it('AppException → 그 status·code·message 봉투', () => {
    const { host, status, json } = mockHost('/posts/1');

    filter.catch(
      new AppException({
        code: 'BOARD_POST_NOT_FOUND',
        status: HttpStatus.NOT_FOUND,
        message: '게시글을 찾을 수 없습니다.',
      }),
      host,
    );

    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 404,
        code: 'BOARD_POST_NOT_FOUND',
        message: '게시글을 찾을 수 없습니다.',
        path: '/posts/1',
      }),
    );
  });

  it('DomainError → 422 + 그 code', () => {
    const { host, status, json } = mockHost();

    filter.catch(new DomainError('제목은 필수입니다.'), host);

    expect(status).toHaveBeenCalledWith(422);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 422, code: 'VALIDATION_FAILED' }),
    );
  });

  it('Nest 기본 HttpException(404) → 파생 코드 HTTP_404', () => {
    const { host, status, json } = mockHost();

    filter.catch(new NotFoundException('x'), host);

    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 404, code: 'HTTP_404' }),
    );
  });

  it('알 수 없는 Error → 500 COMMON_INTERNAL_ERROR', () => {
    const { host, status, json } = mockHost();

    filter.catch(new Error('boom'), host);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 500,
        code: 'COMMON_INTERNAL_ERROR',
      }),
    );
  });

  it('5xx는 Sentry.captureException로 보낸다(userId·role 컨텍스트 첨부)', () => {
    const { host } = mockHost('/posts', 'POST', { sub: 'u1', role: 'OWNER' });

    filter.catch(new Error('boom'), host);

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    // 2번째 인자(scope 콜백)를 mock scope로 실행해 컨텍스트 설정을 검증
    const scopeCb = (Sentry.captureException as jest.Mock).mock.calls[0][1] as (
      s: unknown,
    ) => unknown;
    const setUser = jest.fn();
    const setTag = jest.fn();
    scopeCb({ setUser, setTag });
    expect(setUser).toHaveBeenCalledWith({ id: 'u1' });
    expect(setTag).toHaveBeenCalledWith('role', 'OWNER');
    expect(setTag).toHaveBeenCalledWith('path', '/posts');
    expect(setTag).toHaveBeenCalledWith('method', 'POST');
  });

  it('4xx는 (샘플 비율 0이면) Sentry로 보내지 않는다', () => {
    const { host } = mockHost();

    filter.catch(new NotFoundException('x'), host);

    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('대상 4xx(422 검증)는 샘플 비율이 켜지면 warning으로 캡처한다', () => {
    process.env.SENTRY_4XX_SAMPLE_RATE = '1';
    const { host } = mockHost('/posts', 'POST', { sub: 'u1', role: 'OWNER' });

    filter.catch(new DomainError('제목은 필수입니다.'), host);

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const scopeCb = (Sentry.captureException as jest.Mock).mock.calls[0][1] as (
      s: unknown,
    ) => unknown;
    const setLevel = jest.fn();
    const setTag = jest.fn();
    const setUser = jest.fn();
    scopeCb({ setLevel, setTag, setUser });
    expect(setLevel).toHaveBeenCalledWith('warning');
    expect(setTag).toHaveBeenCalledWith('capture_reason', 'sampled_4xx');
    expect(setTag).toHaveBeenCalledWith('code', 'VALIDATION_FAILED');

    delete process.env.SENTRY_4XX_SAMPLE_RATE;
  });
});
