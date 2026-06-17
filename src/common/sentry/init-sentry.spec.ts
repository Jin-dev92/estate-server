import * as Sentry from '@sentry/nestjs';
import { initSentry } from './init-sentry';

jest.mock('@sentry/nestjs');

describe('initSentry', () => {
  afterEach(() => jest.clearAllMocks());

  it('DSN이 비면 Sentry.init을 호출하지 않고 false를 반환한다(no-op)', () => {
    const enabled = initSentry({
      dsn: '',
      environment: 'test',
      tracesSampleRate: 0.1,
    });

    expect(enabled).toBe(false);
    expect(Sentry.init).not.toHaveBeenCalled();
  });

  it('DSN이 있으면 기대 옵션으로 Sentry.init을 호출하고 true를 반환한다', () => {
    const enabled = initSentry({
      dsn: 'https://k@o0.ingest.sentry.io/1',
      environment: 'production',
      tracesSampleRate: 0.2,
    });

    expect(enabled).toBe(true);
    expect(Sentry.init).toHaveBeenCalledTimes(1);
    const opts = (Sentry.init as jest.Mock).mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(opts.dsn).toBe('https://k@o0.ingest.sentry.io/1');
    expect(opts.environment).toBe('production');
    expect(opts.sendDefaultPii).toBe(false);
    expect(typeof opts.tracesSampler).toBe('function');
    expect(typeof opts.beforeSend).toBe('function');
  });
});
