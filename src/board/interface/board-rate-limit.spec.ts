import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import {
  RATE_LIMIT_OPTIONS,
  RateLimitOptions,
} from '../../common/rate-limit/rate-limit.constants';
import { BoardController } from './board.controller';
import { BOARD_RATE_LIMIT } from './board-rate-limit.constants';

// @RateLimit는 SetMetadata로 핸들러 메서드에 RATE_LIMIT_OPTIONS 메타데이터를 심는다.
// 전역 RateLimitGuard가 이 메타데이터를 읽어 라우트별 한도를 적용하므로,
// 여기서는 board의 '생성' 라우트에 의도한 오버라이드가 실제로 부착됐는지만 검증한다.
// (가드 동작 자체는 rate-limit.guard.spec.ts가 제네릭하게 커버한다.)
describe('BoardController rate limit metadata', () => {
  const reflector = new Reflector();

  // 프로토타입 메서드를 '언바운드로 참조'하면 lint(unbound-method)에 걸리므로,
  // 프로퍼티 디스크립터로 핸들러 함수만 꺼내 메타데이터 조회 대상으로 쓴다.
  function readLimit(handlerName: keyof BoardController): RateLimitOptions {
    const handler = Object.getOwnPropertyDescriptor(
      BoardController.prototype,
      handlerName,
    )?.value as (...args: unknown[]) => unknown;

    return reflector.get<RateLimitOptions>(RATE_LIMIT_OPTIONS, handler);
  }

  describe('생성 라우트(오버라이드 적용 대상)', () => {
    it('should attach CREATE_POST limit to createPostHandler', () => {
      const meta = readLimit('createPostHandler');

      expect(meta).toEqual(BOARD_RATE_LIMIT.CREATE_POST);
    });

    it('should attach CREATE_COMMENT limit to createCommentHandler', () => {
      const meta = readLimit('createCommentHandler');

      expect(meta).toEqual(BOARD_RATE_LIMIT.CREATE_COMMENT);
    });
  });

  describe('그 외 라우트(전역 기본 한도에 위임)', () => {
    // 좋아요/취소·수정·삭제·조회는 오버라이드 없이 전역 가드 기본을 쓴다.
    // 오버라이드가 붙지 않아야(undefined) 정책이 흐트러지지 않음을 보장한다.
    const delegatedHandlers = [
      'likePostHandler',
      'unlikePostHandler',
      'updatePostHandler',
      'deletePostHandler',
      'listPostsHandler',
      'getPostHandler',
    ] as const;

    it.each(delegatedHandlers)(
      'should NOT attach a rate limit override to %s',
      (handlerName) => {
        const meta = readLimit(handlerName);

        expect(meta).toBeUndefined();
      },
    );
  });
});
