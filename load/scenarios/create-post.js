// 시나리오 ②: 쓰기·DB+Outbox 경로 (POST 글작성)
// 무엇을 보나: 글 1건을 만들 때 "글 INSERT + outbox 행 INSERT"를 한 트랜잭션으로 쓰는 비용.
// 구조(options/setup/default/sleep)는 read-posts.js와 동일 — 차이는 POST + 본문(payload)뿐.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE_URL, THRESHOLDS, profileOptions } from '../config.js';
import { login, firstBuildingId, authHeaders } from '../lib/auth.js';

// 쓰기용 threshold(p95<800ms)를 붙인다. 쓰기는 읽기보다 느린 게 정상이라 기준이 더 느슨.
export const options = { ...profileOptions(), thresholds: THRESHOLDS.write };

export function setup() {
  const token = login();
  const buildingId = firstBuildingId(token);
  return { token, buildingId };
}

export default function (data) {
  // 보낼 본문(JSON 문자열). 제목에 Date.now()를 넣어 매 요청 다른 글이 만들어지게 한다.
  // ※ 주의: 이 시나리오는 돌릴수록 DB에 글이 계속 쌓인다(재현성·정리 고려).
  const payload = JSON.stringify({
    category: 'FREE',
    title: `부하 글 ${Date.now()}`,
    content: 'load test',
  });
  const res = http.post(
    `${BASE_URL}/buildings/${data.buildingId}/posts`,
    payload,
    authHeaders(data.token),
  );
  check(res, { 'create 201': (r) => r.status === 201 }); // 생성 성공은 201
  sleep(1);
}
