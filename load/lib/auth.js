// 인증 헬퍼 모음. 시나리오의 setup()에서 호출해 "토큰·건물id"를 한 번만 준비한다.
// (default 함수에서 매번 로그인하면, 로그인 비용이 측정 대상에 섞여버린다. 그래서 setup.)

import http from 'k6/http'; // k6 내장 HTTP 클라이언트(http.get / http.post …)
import { check } from 'k6'; // 응답 검증 함수(아래 설명)
import { BASE_URL, SEED } from '../config.js';

// 시드 OWNER 계정으로 로그인해 accessToken 문자열을 돌려준다.
export function login() {
  // http.post(url, body, params). body는 문자열이어야 하므로 JSON.stringify로 직렬화.
  const res = http.post(
    `${BASE_URL}/auth/login`,
    JSON.stringify({ email: SEED.email, password: SEED.password }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  // check(응답, { '라벨': (r) => 조건 }): 조건이 참이면 통과로 집계. 중요한 점 —
  // check는 assert가 아니다. 실패해도 테스트를 멈추지 않고 "성공률"만 깎는다.
  // (멈추는 합격/불합격은 config의 threshold가 담당한다.)
  check(res, { 'login 200/201': (r) => r.status === 200 || r.status === 201 });
  // res.json('accessToken') = 응답 JSON에서 accessToken 필드만 꺼낸다.
  return res.json('accessToken');
}

// 로그인한 토큰으로 내 건물 목록을 받아 첫 건물 id를 돌려준다(시드가 만든 건물).
export function firstBuildingId(token) {
  const res = http.get(`${BASE_URL}/buildings`, {
    // 보호된 API라 Authorization 헤더에 Bearer 토큰을 실어 보낸다.
    headers: { Authorization: `Bearer ${token}` },
  });
  check(res, { 'buildings 200': (r) => r.status === 200 });
  const list = res.json(); // 인자 없이 호출하면 응답 본문 전체를 파싱(여기선 배열).
  return Array.isArray(list) && list.length > 0 ? list[0].id : null;
}

// 보호된 요청에 공통으로 붙이는 헤더(토큰 + JSON). http.get/post의 마지막 인자로 넘긴다.
export function authHeaders(token) {
  return {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };
}
