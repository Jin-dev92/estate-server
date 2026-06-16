// 부하 프로파일·threshold·공통 설정. env로 오버라이드한다.
// 예: BASE_URL=http://localhost:3000 PROFILE=load k6 run load/scenarios/read-posts.js
export const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

// 시드(prisma/seed-load.ts)와 공유하는 고정 자격증명.
export const SEED = {
  email: __ENV.LOAD_EMAIL || 'load-owner@example.com',
  password: __ENV.LOAD_PASSWORD || 'load-test-1234',
};

// PROFILE=smoke(정상성) | load(baseline). VUS·DURATION으로 미세 조정.
const PROFILE = __ENV.PROFILE || 'smoke';

const PROFILES = {
  smoke: { vus: Number(__ENV.VUS) || 1, duration: __ENV.DURATION || '30s' },
  load: {
    stages: [
      { duration: '30s', target: Number(__ENV.VUS) || 20 },
      { duration: '1m', target: Number(__ENV.VUS) || 20 },
      { duration: '10s', target: 0 },
    ],
  },
};

export function profileOptions() {
  return PROFILES[PROFILE] || PROFILES.smoke;
}

// 엔드포인트 성격별 threshold(설계 §3).
export const THRESHOLDS = {
  read: { http_req_duration: ['p95<300'], http_req_failed: ['rate<0.01'] },
  write: { http_req_duration: ['p95<800'], http_req_failed: ['rate<0.01'] },
  login: { http_req_duration: ['p95<1000'], http_req_failed: ['rate<0.01'] },
};
