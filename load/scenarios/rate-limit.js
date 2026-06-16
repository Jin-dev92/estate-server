// 시나리오 ④: rate limit 경계 검증
// 이건 "성능 baseline"이 아니라 "기능이 맞게 도는가" 테스트다.
// 한도를 일부러 낮춰(예: ipMax=10) 띄운 앱에 빠르게 반복 요청 → 한도를 넘으면 429가 오는가?
// 실행 전제: `RATE_LIMIT_IP_MAX=10 RATE_LIMIT_WINDOW_SEC=60 node dist/main.js`로 앱 기동.

import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics'; // 직접 만드는 "카운터" 메트릭
import { BASE_URL, SEED } from '../config.js';

// Counter = 내가 정의하는 커스텀 메트릭(숫자를 누적). 여기선 429를 몇 번 봤는지 센다.
// k6 내장 메트릭(http_req_duration 등) 외에 "내가 보고 싶은 수치"를 만들 때 쓴다.
const got429 = new Counter('rate_limited_429');

export const options = {
  vus: 1, // 1명이
  iterations: 20, // 총 20번 요청(duration 대신 "횟수"로 끝낸다). ipMax=10보다 많아야 429를 본다.
  // 429는 의도된 정상 동작이라, 실패율(threshold)을 두지 않는다.
};

export default function () {
  const res = http.post(
    `${BASE_URL}/auth/login`,
    JSON.stringify({ email: SEED.email, password: SEED.password }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  // 429가 왔을 때만: 카운터를 올리고, 응답이 우리 규약대로 생겼는지 검사한다.
  if (res.status === 429) {
    got429.add(1); // 카운터 +1
    check(res, {
      // 에러 봉투의 code가 약속된 값인가 (res.json('code')로 JSON 필드 추출)
      '429 body code': (r) => r.json('code') === 'RATE_LIMIT_EXCEEDED',
      // "언제 다시 시도하라"는 Retry-After 헤더가 붙어 있는가 (res.headers로 헤더 접근)
      '429 Retry-After 존재': (r) => r.headers['Retry-After'] !== undefined,
    });
  }
}

// handleSummary(): 테스트가 끝나면 1번 호출되는 "결과 요약 커스텀" 훅.
// data.metrics에 모든 메트릭이 들어온다. 우리가 만든 rate_limited_429의 누적값을 찍는다.
// (429를 한 번도 못 봤다면 한도가 안 먹었다는 뜻 → count로 확인.)
export function handleSummary(data) {
  const count = data.metrics.rate_limited_429
    ? data.metrics.rate_limited_429.values.count
    : 0;
  console.log(`429 관측 횟수: ${count}`);
  return {}; // 빈 객체 = 기본 요약 출력은 생략(우리 로그만 본다)
}
