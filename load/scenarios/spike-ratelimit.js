// =============================================================================
// 시나리오 ⑥(M8): spike(스파이크) 테스트 — "급증 충격을 막아내고, 회복하나"
// =============================================================================
// ▶ 부하테스트가 처음이라면: spike는 "평소엔 한가하다가 갑자기 트래픽이 폭증"하는
//   상황을 흉내 낸다(예: 이벤트 오픈, 푸시 알림 직후). 묻는 건 두 가지다.
//     ① 막아내나  — 폭증분을 잘 쳐내고 "앱이 죽지 않는가".
//     ② 회복하나  — 폭증이 끝난 뒤 다시 평소처럼 정상 동작으로 돌아오는가
//                   (밀린 요청이 계속 밀려 후유증이 남지 않는가).
//   ※ stress(stress-create.js)가 "한계가 어디냐"라면, spike는 "충격에 견디고
//     원래대로 돌아오느냐"를 본다. 목적이 다르다.
//
// ▶ 핵심 용어:
//   - RPS = 초당 요청 수(부하의 세기).
//   - rate limit(요청 수 제한) = "일정 시간(window) 안에 이 사용자/IP는 N건까지만"
//       이라는 방어선. 한도를 넘으면 서버가 일을 안 하고 곧장 429를 돌려준다.
//   - 429 = HTTP "Too Many Requests"(요청이 너무 많음). 이 프로젝트에선 본문에
//       code: "RATE_LIMIT_EXCEEDED"가 담겨 온다. → 429는 "에러"가 아니라
//       "방어가 제대로 작동했다"는 신호다(아래 실패율 주석 참고).
//   - window(고정 윈도우) = 한도를 세는 시간 칸. 예: window=10초, 한도=200이면
//       "매 10초마다 200건까지 허용". 10초가 지나면 카운터가 리셋된다.
//
// ▶ 무엇을 보나(이 파일의 구체 동작): 평상시 낮은 RPS를 유지하다 짧게 확 치솟게
//   (급증) 한 뒤 다시 낮춘다.
//     ① 급증분이 429(RATE_LIMIT_EXCEEDED)로 차단되고 앱이 안 죽는가(5xx 없음),
//     ② 급증 후 평상시 구간에서 지표가 baseline(평소) 수준으로 회복되는가.
//
// ▶ 실행 전제(중요): 여기선 "방어가 작동하는가"가 관심사다. 그래서 stress와 반대로
//   rate limit을 정상/유한 한도로 띄운다(절대 크게 풀지 않는다). window를 짧게(10s)
//   두면 "리셋 → 회복"을 빨리 관찰할 수 있다.
//     RATE_LIMIT_WINDOW_SEC=10 RATE_LIMIT_USER_MAX=200 RATE_LIMIT_IP_MAX=200 node dist/main.js
//     (+ npm run start:worker:outbox — 글작성이 Outbox 경로를 쓴다)
//
// ▶ 실행:  SPIKE_PEAK_RATE=300 k6 run load/scenarios/spike-ratelimit.js
//
// ▶ k6 기본기(VU·iteration·생명주기·open/closed 모델)는 ../config.js 맨 위 주석과
//   stress-create.js 헤더에 자세히 있다.
// =============================================================================

import http from 'k6/http'; // k6 내장 HTTP 클라이언트
import { check } from 'k6'; // 개별 응답 검증(실패해도 멈추지 않음)
import { Counter } from 'k6/metrics'; // 내가 직접 세는 커스텀 숫자 메트릭
import { BASE_URL } from '../config.js'; // 테스트 대상 서버 주소
import { login, firstBuildingId, authHeaders } from '../lib/auth.js'; // 로그인·건물id 헬퍼

// __ENV(셸 환경변수)로 부하 모양을 조절 — 값을 코드에 박지 않는다.
const BASE_RATE = Number(__ENV.SPIKE_BASE_RATE) || 5; // 평상시 초당 요청(낮게)
const PEAK_RATE = Number(__ENV.SPIKE_PEAK_RATE) || 300; // 급증 정점(확 치솟는 높이)
const MAX_VUS = Number(__ENV.SPIKE_MAX_VUS) || 800; // VU 상한(급증 시 도착률 유지용, 넉넉히)

// 커스텀 카운터 2개: "막은 양(429)"과 "통과한 양(2xx)"을 따로 세어
// 방어가 얼마나/어떻게 작동했는지 숫자로 본다.
const blocked429 = new Counter('blocked_429');
const passed2xx = new Counter('passed_2xx');

// options = 이 부하의 "모양". k6가 읽고 부하를 만든다.
export const options = {
  scenarios: {
    spike: {
      // open(arrival-rate) 모델: "초당 X건" 도착률을 못 박고 밀어붙인다. 급증을
      // 만들려면 이 모델이라야 한다(closed/VU 모델은 시스템이 느려지면 부하도 줄어
      // 급증이 무뎌진다). ramping = 도착률을 단계적으로 바꾼다.
      executor: 'ramping-arrival-rate',
      startRate: BASE_RATE, // 평상시 도착률에서 시작
      timeUnit: '1s', // target/timeUnit = 초당 몇 건
      preAllocatedVUs: 50, // 미리 만들어 둘 VU
      maxVUs: MAX_VUS, // VU 상한(__ENV.SPIKE_MAX_VUS). 급증 순간 도착률을 채우려면 넉넉해야.
      // stages = 시간에 따라 도착률을 바꾸는 단계들. 아래가 "스파이크 모양"을 만든다:
      //   평상시 유지 → 5초 만에 확 치솟음 → 잠깐 유지 → 평상시로 복귀 → 회복 관찰.
      stages: [
        { target: BASE_RATE, duration: '20s' }, // 평상시(baseline 구간 = 비교 기준)
        { target: PEAK_RATE, duration: '5s' }, // 급증(확 치솟음)
        { target: PEAK_RATE, duration: '10s' }, // 급증 유지(충격 지속)
        { target: BASE_RATE, duration: '5s' }, // 복귀(평상시로 내림)
        { target: BASE_RATE, duration: '30s' }, // 회복 관찰(원래대로 돌아오나)
      ],
    },
  },
  // stress와 마찬가지로 threshold(합격기준)를 안 둔다. 특히 실패율 기준을 두면 안 된다:
  // 아래 설명대로 429(정상 방어)가 '실패'로 잡혀 부당하게 빨강이 되기 때문.
};

// setup(): 시작 시 1번. 토큰·건물id를 미리 준비해 모든 VU가 공유한다.
export function setup() {
  // 로그인은 여기서 딱 1번만 호출한다. (로그인 라우트엔 @RateLimit({ipMax:10})이
  // 붙어 있어 자주 부르면 막히지만, 1회뿐이라 안 걸린다.)
  const token = login();
  const buildingId = firstBuildingId(token);
  return { token, buildingId };
}

// default(): 가상 사용자가 계속 반복. 1회 = 글작성 요청 1건.
export default function (data) {
  const payload = JSON.stringify({
    category: 'FREE',
    title: `spike ${Date.now()}`,
    content: 'load test',
  });
  const res = http.post(
    `${BASE_URL}/buildings/${data.buildingId}/posts`,
    payload,
    authHeaders(data.token),
  );
  // 응답을 두 부류로 나눠 센다:
  //   429 = rate limit이 막아낸 것(방어 성공) → blocked429 +1
  //   2xx = 한도 내라 정상 처리된 것(통과)     → passed2xx +1
  if (res.status === 429) blocked429.add(1);
  else if (res.status >= 200 && res.status < 300) passed2xx.add(1);
  // 핵심 합격 조건: 급증해도 "앱이 죽지 않는다" = 5xx(서버에러)가 아니다.
  // (429로 점잖게 거절하는 것은 OK. 500/503으로 뻗는 것은 실패.)
  check(res, { 'no server error (<500)': (r) => r.status < 500 });
}

// handleSummary(): 끝나면 1번. 원하는 한 줄 요약을 직접 만들어 출력한다.
// ※ 중요: k6의 http_req_failed(실패율)는 429도 '실패'로 센다. 그래서 이 시나리오의
//   실패율이 높게 나오는 건 "장애"가 아니라 "방어가 그만큼 많이 막았다"는 뜻이다.
//   진짜 장애 신호는 5xx인데, 그건 위 check('no server error')로 따로 본다.
export function handleSummary(data) {
  const m = data.metrics;
  const p95 = m.http_req_duration ? m.http_req_duration.values['p(95)'] : 0;
  const failRate = m.http_req_failed ? m.http_req_failed.values.rate : 0;
  const b = m.blocked_429 ? m.blocked_429.values.count : 0; // 막은 양(우리 카운터)
  const p = m.passed_2xx ? m.passed_2xx.values.count : 0; // 통과한 양(우리 카운터)
  console.log(
    '[spike 요약] p95=' +
      p95.toFixed(1) +
      'ms (429포함)실패율=' +
      (failRate * 100).toFixed(2) +
      '% 차단(429)=' +
      b +
      ' 통과(2xx)=' +
      p,
  );
  return {}; // k6 기본 요약표는 생략하고 위 한 줄만 본다.
}
