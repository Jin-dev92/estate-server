import { scrubEvent } from './sentry-scrub';

describe('scrubEvent', () => {
  it('민감 헤더(Authorization·Cookie)를 마스킹한다(대소문자 무관)', () => {
    const event = {
      request: {
        headers: { Authorization: 'Bearer x', cookie: 'a=b', 'x-trace': 'ok' },
      },
    };

    const result = scrubEvent(event);

    expect(result.request?.headers).toEqual({
      Authorization: '***',
      cookie: '***',
      'x-trace': 'ok',
    });
  });

  it('request가 없어도 안전하게 그대로 반환한다', () => {
    const event = { request: undefined };
    expect(scrubEvent(event)).toEqual({ request: undefined });
  });

  it('민감하지 않은 헤더는 그대로 둔다', () => {
    const event = { request: { headers: { 'x-trace': 'ok' } } };
    expect(scrubEvent(event).request?.headers).toEqual({ 'x-trace': 'ok' });
  });
});
