// ============================================================================
// k6 입문 메모 (이 폴더의 모든 스크립트 공통)
// ----------------------------------------------------------------------------
// k6는 "부하테스트 도구"다. JS로 시나리오를 쓰지만 Node가 아니라 k6 자체 런타임에서
// 돈다. 그래서 `require`·`fs` 같은 Node API는 없고, 대신 `k6/http`·`k6/metrics`
// 같은 k6 내장 모듈을 import한다. 실행: `k6 run load/scenarios/read-posts.js`.
//
// k6 스크립트의 4가지 export(생명주기)는 이름이 약속돼 있다:
//   export const options      // (정적) 부하의 "모양": 가상사용자 수·시간·합격기준
//   export function setup()    // 테스트 시작 시 "딱 1번": 데이터 준비(로그인 등)
//   export default function()  // 가상사용자(VU)마다 "계속 반복": 실제 측정 대상
//   export function teardown() // 끝에 1번: 정리 (이 프로젝트는 안 씀)
//
// 용어:
//   VU(Virtual User) = 가상 사용자 1명. VU 20 = 20명이 동시에 반복 요청.
//   iteration        = default 함수 1회 실행(= 1명이 1번 행동).
//   __ENV.X          = 셸 환경변수 X. 예: `PROFILE=load k6 run ...` → __ENV.PROFILE.
//
// 이 파일(config.js)은 스크립트가 아니라 "공통 설정 모음"이다. 각 시나리오가 여기서
// BASE_URL·프로파일·threshold를 import해서 쓴다.
// ============================================================================

// 테스트 대상 서버 주소. 환경변수 BASE_URL이 있으면 그걸, 없으면 로컬 기본값을 쓴다.
// (`A || B`: A가 비었으면 B. k6 전역 __ENV로 셸 환경변수를 읽는다.)
export const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

// 로그인에 쓸 고정 계정. prisma/seed-load.ts가 미리 만들어 둔 부하테스트 전용 유저와
// 반드시 같아야 한다(시드와 여기 둘 다 'load-owner@example.com'/'load-test-1234').
export const SEED = {
  email: __ENV.LOAD_EMAIL || 'load-owner@example.com',
  password: __ENV.LOAD_PASSWORD || 'load-test-1234',
};

// 부하의 "강도 프로파일"을 환경변수로 고른다.
//   smoke = 약하게 짧게(스크립트가 잘 도는지 확인용, 부하 아님)
//   load  = baseline 측정용(점점 사용자를 늘렸다가 줄임)
const PROFILE = __ENV.PROFILE || 'smoke';

const PROFILES = {
  // smoke: VU 1명이 30초 동안 반복. 정상성 확인.
  smoke: { vus: Number(__ENV.VUS) || 1, duration: __ENV.DURATION || '30s' },
  // load: "stages"는 시간에 따라 VU 수를 바꾸는 단계들(ramp).
  //   30초에 걸쳐 0→20명으로 늘리고(가속), 1분간 20명 유지(정상상태 측정),
  //   마지막 10초에 20→0명으로 줄인다(감속). 초반 가속이 워밍업 역할도 한다.
  load: {
    stages: [
      { duration: '30s', target: Number(__ENV.VUS) || 20 },
      { duration: '1m', target: Number(__ENV.VUS) || 20 },
      { duration: '10s', target: 0 },
    ],
  },
};

// 고른 프로파일의 옵션 객체를 돌려준다. 각 시나리오가 `...profileOptions()`로 펼쳐 쓴다.
export function profileOptions() {
  return PROFILES[PROFILE] || PROFILES.smoke;
}

// threshold(임계치) = "합격 기준". 미달하면 k6가 0이 아닌 코드로 종료한다(→ CI에서 빨강).
//   http_req_duration = 요청 응답시간(내장 메트릭). 'p(95)<300' = 95퍼센타일이 300ms 미만.
//     ※ 평균이 아니라 p95/p99로 보는 이유: 평균은 "느린 꼬리"를 숨기기 때문.
//   http_req_failed   = 실패율(2xx/3xx가 아닌 응답 비율). 'rate<0.01' = 1% 미만.
// 엔드포인트 성격이 다르니 기준도 다르게 둔다(읽기는 빨라야, 로그인은 bcrypt라 느려도 OK).
export const THRESHOLDS = {
  read: { http_req_duration: ['p(95)<300'], http_req_failed: ['rate<0.01'] },
  write: { http_req_duration: ['p(95)<800'], http_req_failed: ['rate<0.01'] },
  // login은 일부러 실패율 기준을 뺐다. login 라우트에 @RateLimit({ipMax:10})이
  // 하드코딩이라 env로 한도를 못 올린다 → 부하를 주면 대부분 429(rate limit)가 된다.
  // 그건 "보안이 정상 작동"하는 거라 실패로 잡으면 안 된다. 그래서 응답시간만 본다.
  // (순수 로그인 속도는 smoke 프로파일 = 윈도우당 10회 이하로 따로 잰다.)
  login: { http_req_duration: ['p(95)<1000'] },
};
