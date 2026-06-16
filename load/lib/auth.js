import http from 'k6/http';
import { check } from 'k6';
import { BASE_URL, SEED } from '../config.js';

// 시드 OWNER로 로그인해 accessToken을 얻는다(시나리오 setup에서 1회 호출).
export function login() {
  const res = http.post(
    `${BASE_URL}/auth/login`,
    JSON.stringify({ email: SEED.email, password: SEED.password }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  check(res, { 'login 200/201': (r) => r.status === 200 || r.status === 201 });
  return res.json('accessToken');
}

// 로그인 후 내 건물 목록에서 첫 건물 id를 얻는다(시드가 만든 건물).
export function firstBuildingId(token) {
  const res = http.get(`${BASE_URL}/buildings`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  check(res, { 'buildings 200': (r) => r.status === 200 });
  const list = res.json();
  return Array.isArray(list) && list.length > 0 ? list[0].id : null;
}

export function authHeaders(token) {
  return {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };
}
