// =============================================================================
// 시나리오 ⑤(M8): stress(스트레스) 테스트 — "어디서 무너지나(한계점·병목)" 찾기
// =============================================================================
// ▶ 부하테스트가 처음이라면 이것부터:
//   - "부하테스트"는 서버에 가짜 사용자(요청)를 잔뜩 보내 성능을 재는 것이다.
//   - 종류가 목적별로 나뉜다:
//       · smoke = 아주 약하게(스크립트가 잘 도나 확인)
//       · load  = 예상 평소 수준(정상 트래픽에서 빠른가 = baseline)
//       · stress= 부하를 "계속 올려" 무너지는 지점을 찾는다  ← 이 파일
//       · spike = 갑자기 확 쏴서 충격을 견디는지 본다       ← spike-ratelimit.js
//   - 이 파일(stress)의 목적은 합격/불합격이 아니라 "한계 탐색"이다.
//
// ▶ 핵심 용어(이 파일에 계속 나온다):
//   - RPS = Requests Per Second = 초당 요청 수. 부하의 세기.
//   - p95 = 응답시간 95퍼센타일. "100명 중 95등의 응답시간". 평균은 느린 사람을
//           숨기므로, 느린 꼬리까지 보려고 p95/p99로 본다. (예: p95=200ms면 95%가
//           200ms 안에 끝났고 5%는 더 느렸다는 뜻.)
//   - knee(무릎) = 부하를 올리다 p95가 갑자기 꺾여 치솟는 지점 = 한계점.
//   - 병목 = 한계에서 "먼저 터지는 자원". 여기선 DB 커넥션 풀이 후보다.
//   - 커넥션 풀(connection pool) = 앱이 DB와 미리 맺어두고 돌려쓰는 연결 묶음.
//           풀이 N개면 "동시에 N개의 쿼리"만 가능하고 나머지는 줄을 선다.
//
// ▶ 무엇을 보나: POST 글작성의 RPS를 단계적으로 올릴 때, 어느 지점에서 p95가
//   급증하고 5xx(서버에러)가 시작되는가(=knee). 그 순간 앱 로그에 Prisma의
//   "풀 타임아웃"(연결을 기다리다 포기, 에러코드 P2024)이 찍히면
//   → "병목 = DB 커넥션 풀"이라는 움직일 수 없는 증거다.
//
// ▶ 왜 풀을 일부러 좁히나(실행 전제, 중요):
//   k6·앱·DB가 한 노트북에서 돌면 "앱이 아니라 내 머신이 먼저" 죽어버려 측정이
//   무의미해진다. 그래서 DB 풀을 1로 콱 좁혀(connection_limit=1) "머신보다 앱이
//   먼저, 그것도 우리가 예측한 지점에서" 무너지게 만드는 통제된 실험으로 바꾼다.
//     DATABASE_URL="...?...&connection_limit=1&pool_timeout=1" \
//     RATE_LIMIT_USER_MAX=1000000 RATE_LIMIT_IP_MAX=1000000 node dist/main.js
//     (+ npm run start:worker:outbox — 글작성은 Outbox 경로를 함께 쓴다)
//   ※ rate limit은 일부러 크게 풀어 둔다. 지금 보고 싶은 건 "DB 풀 한계"이지
//      "요청 수 제한(rate limit)"이 아니기 때문. (rate limit을 보는 건 spike 쪽.)
//
// ▶ 실행(P2024 풀 타임아웃까지 보려면 오래·깊게 민다):
//     STRESS_STAGE=40s STRESS_PEAK_RATE=600 STRESS_MAX_VUS=2000 k6 run load/scenarios/stress-create.js
//
// ▶ k6 기본기(VU·iteration·생명주기 setup/default·__ENV)는 ../config.js 맨 위
//   주석에 자세히 있다. 여기선 stress에 필요한 것만 다시 짚는다.
// =============================================================================

import http from 'k6/http'; // k6 내장 HTTP 클라이언트(http.get/http.post)
import { check } from 'k6'; // 개별 응답 검증(실패해도 멈추지 않고 성공률만 집계)
import { Counter } from 'k6/metrics'; // 내가 직접 세는 커스텀 숫자 메트릭
import { BASE_URL } from '../config.js'; // 테스트 대상 서버 주소
import { login, firstBuildingId, authHeaders } from '../lib/auth.js'; // 로그인·건물id 헬퍼

// 단계별 도착률(초당 요청수). __ENV(셸 환경변수)로 조절 — 값을 코드에 박지 않는다.
// 예: STRESS_PEAK_RATE=600 k6 run ...  → __ENV.STRESS_PEAK_RATE가 '600'이 된다.
const PEAK_RATE = Number(__ENV.STRESS_PEAK_RATE) || 100; // 마지막 단계의 정점 RPS
const STAGE = __ENV.STRESS_STAGE || '30s'; // 각 단계를 몇 초 유지할지
// VU(Virtual User=가상 사용자)의 상한. open 모델에선 요청이 느려지면 "응답을 기다리는"
// VU가 쌓이므로, 도착률을 유지하려고 k6가 VU를 더 만든다. 병목으로 적체가 깊어질수록
// 더 많은 VU가 필요 → P2024(연결 대기 타임아웃)까지 보려면 이 상한을 넉넉히 키운다.
const MAX_VUS = Number(__ENV.STRESS_MAX_VUS) || 500;

// 커스텀 카운터: HTTP 5xx(서버에러) 응답을 몇 번 봤는지 누적해서 센다.
// k6 내장 메트릭 외에 "내가 보고 싶은 수치"를 만들 때 Counter를 쓴다.
const errors5xx = new Counter('server_errors_5xx');

// options = 이 부하의 "모양"을 정의하는 약속된 export. k6가 이걸 읽고 부하를 만든다.
export const options = {
  // scenarios = 부하를 어떻게 만들지(executor=실행기)를 지정. 여기선 한 개만 둔다.
  scenarios: {
    stress: {
      // ── open 모델 vs closed 모델 (stress의 핵심) ──────────────────────────
      // closed(VU 고정) 모델: "사용자 N명이 응답을 받고 → 다음 요청"을 반복.
      //   시스템이 느려지면 사용자도 덩달아 천천히 보내므로 부하가 저절로 줄어든다
      //   → 적체(backpressure)가 숨어버린다. (정상 baseline 측정엔 충분.)
      // open(arrival-rate) 모델: "초당 X건"이라는 도착률을 못 박고, 시스템이 느려져도
      //   봐주지 않고 계속 들이민다 → 줄이 길어지고 한계가 드러난다. stress엔 이게 필수.
      executor: 'ramping-arrival-rate', // ramping = 도착률을 단계적으로 올린다
      startRate: 10, // 시작은 초당 10건
      timeUnit: '1s', // 도착률의 시간 단위. target/timeUnit = 초당 몇 건.
      preAllocatedVUs: 50, // 시작 시 미리 만들어 둘 VU 수(워밍업)
      maxVUs: MAX_VUS, // VU 상한. 부족하면 k6가 "Insufficient VUs" 경고를 낸다.
      // stages = 시간에 따라 목표 도착률을 바꾸는 단계들. 아래는 10→30→60→정점으로
      //   계단처럼 올린다. 올리다 보면 어느 단계에서 p95가 꺾인다 = 그게 knee.
      stages: [
        { target: 10, duration: STAGE },
        { target: 30, duration: STAGE },
        { target: 60, duration: STAGE },
        { target: PEAK_RATE, duration: STAGE },
      ],
    },
  },
  // threshold(합격기준)를 일부러 안 둔다: stress는 "통과/실패 판정"이 목적이 아니라
  // "어디서 무너지나"를 관찰하는 것이라, 기준으로 죽이지 않고 곡선을 끝까지 기록한다.
};

// setup(): 테스트 시작 시 딱 1번 실행. 무거운 준비(로그인·건물id 조회)를 여기서 끝낸다.
// 매 요청마다 로그인하면 로그인 비용이 측정에 섞이므로, 토큰을 한 번만 받아 공유한다.
// 반환값은 아래 default 함수에 data 인자로 전달된다.
export function setup() {
  const token = login();
  const buildingId = firstBuildingId(token);
  return { token, buildingId };
}

// default(): 가상 사용자가 "계속 반복"하는 본문. 이 1회가 곧 측정 1건이다.
// data = setup이 돌려준 { token, buildingId }.
export default function (data) {
  // 보낼 글 본문(JSON 문자열). 제목에 Date.now()를 넣어 매번 다른 글이 만들어지게 한다.
  const payload = JSON.stringify({
    category: 'FREE',
    title: `stress ${Date.now()}`,
    content: 'load test',
  });
  const res = http.post(
    `${BASE_URL}/buildings/${data.buildingId}/posts`,
    payload,
    authHeaders(data.token), // Authorization: Bearer 토큰 헤더
  );
  // check: 201(생성 성공)인지 확인. 실패해도 멈추지 않고 성공률에만 반영된다.
  check(res, { 'create 201': (r) => r.status === 201 });
  // 5xx(서버에러)면 병목에 도달했다는 신호 → 카운터를 +1. (풀 고갈 시 500이 뜬다.)
  if (res.status >= 500) errors5xx.add(1);
  // ※ closed 모델 시나리오와 달리 sleep(think time)을 넣지 않는다. open 모델은
  //    executor가 "초당 몇 건"을 직접 맞추므로, 쉬는 시간을 우리가 넣으면 안 된다.
}

// handleSummary(): 테스트가 끝나면 1번 호출되는 "결과 요약 커스텀" 훅.
// 보통은 k6가 알아서 표를 출력하지만, 여기선 우리가 원하는 한 줄만 찍는다.
// data.metrics 안에 모든 측정값이 들어있고, 거기서 직접 꺼내 계산한다.
// (각 메트릭이 없을 수도 있으니 `있으면 값, 없으면 0` 형태로 안전하게 꺼낸다.)
export function handleSummary(data) {
  const m = data.metrics;
  // http_req_duration = 응답시간(k6 내장). .values['p(95)']로 p95를 꺼낸다.
  const p95 = m.http_req_duration ? m.http_req_duration.values['p(95)'] : 0;
  // http_req_failed = 실패율(2xx/3xx가 아닌 응답 비율). 0~1 사이라 %로 환산한다.
  const failRate = m.http_req_failed ? m.http_req_failed.values.rate : 0;
  const reqs = m.http_reqs ? m.http_reqs.values.count : 0; // 총 요청 수
  const rps = m.http_reqs ? m.http_reqs.values.rate : 0; // 실제 달성한 평균 RPS
  const e5xx = m.server_errors_5xx ? m.server_errors_5xx.values.count : 0; // 우리 카운터
  // dropped_iterations = open 모델에서 maxVUs가 모자라 "도착률을 못 채워 버린" 요청 수.
  //   이게 크면 부하가 앱이 아니라 k6 쪽에 막혀 쌓였다는 뜻(앱 큐가 그만큼 안 깊어짐).
  //   → 진짜 한계를 보려면 maxVUs를 키워 이 값을 줄여야 한다.
  const dropped = m.dropped_iterations ? m.dropped_iterations.values.count : 0;
  console.log(
    '[stress 요약] p95=' +
      p95.toFixed(1) +
      'ms 실패율=' +
      (failRate * 100).toFixed(2) +
      '% 총요청=' +
      reqs +
      ' RPS=' +
      rps.toFixed(1) +
      ' 5xx(병목)=' +
      e5xx +
      ' dropped=' +
      dropped,
  );
  return {}; // 빈 객체 = k6 기본 요약표는 생략하고 위 한 줄만 본다.
}
