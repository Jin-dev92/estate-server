// 시나리오 ①: 읽기·캐시 경로 (GET 게시글 목록)
// 무엇을 보나: 같은 목록을 반복 조회 → Redis read-through 캐시가 잘 받쳐주는가(응답시간).
// 실행: PROFILE=load k6 run load/scenarios/read-posts.js
// (k6 생명주기 전체 설명은 ../config.js 맨 위 주석 참고)

import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE_URL, THRESHOLDS, profileOptions } from '../config.js';
import { login, firstBuildingId, authHeaders } from '../lib/auth.js';

// options = 부하의 "모양". profileOptions()로 VU·시간(프로파일)을 펼치고,
// thresholds(합격 기준)는 읽기용을 붙인다. (스프레드 ...로 두 객체를 합침)
export const options = { ...profileOptions(), thresholds: THRESHOLDS.read };

// setup(): 테스트 시작 시 "딱 1번" 실행. 무거운 준비(로그인·건물id 조회)를 여기서 끝내고,
// 반환한 객체가 아래 default 함수에 data 인자로 전달된다(모든 VU가 공유).
export function setup() {
  const token = login();
  const buildingId = firstBuildingId(token);
  return { token, buildingId };
}

// default(): 각 VU가 "계속 반복" 실행. 이 1회가 곧 측정 1건. data = setup의 반환값.
export default function (data) {
  const res = http.get(
    `${BASE_URL}/buildings/${data.buildingId}/posts`,
    authHeaders(data.token), // Authorization 헤더(토큰) 부착
  );
  check(res, { 'list 200': (r) => r.status === 200 });
  // sleep(1): "think time". 실제 사용자처럼 요청 사이 1초 쉰다. 빼면 쉬지 않고 쏴서
  // "최대 처리량"을 재고, 넣으면 "현실적 동시 사용자"를 잰다. baseline엔 넣는 게 정직.
  sleep(1);
}
