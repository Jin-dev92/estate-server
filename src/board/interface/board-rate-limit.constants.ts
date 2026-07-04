import { RateLimitOptions } from '../../common/rate-limit/rate-limit.constants';

// board 라우트별 rate limit 오버라이드(분당, userId+IP 이중).
// 매직넘버 하드코딩 금지 — 라우트 성격별 한도를 의미 있는 이름으로 단일 출처 관리한다.
//
// 정책(차등): 스팸 표면이 큰 '생성' 라우트만 전역 기본(user 60 / ip 120)보다 조인다.
// 좋아요/취소는 멱등이고 피드 스크롤 중 연타를 허용해야 하므로 오버라이드 없이 전역 기본을 쓴다.
// 수정/삭제·조회도 전역 가드 기본(쓰기=기본 한도, GET=제외)에 맡긴다.
//
// 아래 수치는 M6 초기값이다. 실제 운영 트래픽 관찰 후 재조정될 수 있다.
export const BOARD_RATE_LIMIT = {
  // 게시글 작성: 본문이 큰 생성이라 가장 타이트하게(스팸 글 방지).
  CREATE_POST: { userMax: 20, ipMax: 30 },
  // 댓글 작성: 게시글보다 빈번한 정상 사용이 있어 다소 완화.
  CREATE_COMMENT: { userMax: 30, ipMax: 60 },
} as const satisfies Record<string, RateLimitOptions>;
