// 시나리오 ③: 인증 경로 (POST 로그인)
// 무엇을 보나: 로그인은 비밀번호를 bcrypt로 검증한다 = CPU를 많이 먹는 작업. 그 응답시간.
// setup()이 없는 이유: 다른 시나리오는 "로그인해서 토큰 받기"가 준비 단계였지만,
// 여기선 로그인 자체가 측정 대상이라 default에서 바로 로그인을 때린다.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE_URL, SEED, THRESHOLDS, profileOptions } from '../config.js';

// ⚠️ "측정이 측정을 방해"하는 대표 사례:
// 로그인 라우트에는 @RateLimit({ipMax:10})이 코드에 박혀 있어, 환경변수로 한도를 못 올린다.
// → load 프로파일(VU 여러 명)로 돌리면 11번째 요청부터 전부 429(차단)가 된다.
//   그건 우리 rate limit이 "의도대로 막는" 정상 동작이라 실패로 보면 안 된다.
// → 그래서 (1) config의 THRESHOLDS.login은 실패율 기준을 뺐고,
//        (2) 순수 로그인 속도(bcrypt)는 smoke 프로파일(요청이 적어 한도에 안 걸림)로 잰다.
export const options = { ...profileOptions(), thresholds: THRESHOLDS.login };

export default function () {
  const res = http.post(
    `${BASE_URL}/auth/login`,
    JSON.stringify({ email: SEED.email, password: SEED.password }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  // 429(rate limit 차단)도 "예상된 정상 응답"으로 보고 check를 통과시킨다.
  // 이렇게 안 하면 부하 시 check 성공률이 1%까지 떨어져 잘못된 경보가 된다.
  check(res, {
    'login 200/201/429': (r) =>
      r.status === 200 || r.status === 201 || r.status === 429,
  });
  sleep(1);
}
