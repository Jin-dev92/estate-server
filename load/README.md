# 부하테스트 (k6)

성격이 다른 핵심 엔드포인트의 성능 baseline(p95·RPS·에러율)을 측정한다.

## 사전 준비
1. k6 설치: `brew install k6` (또는 https://k6.io/docs/get-started/installation/)
2. 인프라: `docker compose up -d`
3. 앱: `npm run build && node dist/main.js` (글작성 부하 시 `npm run start:worker:outbox`도 함께)
4. 시드: `npm run load:seed`

## 실행
| 명령 | 시나리오 |
|---|---|
| `npm run load:smoke` | 전체 smoke(정상성) |
| `npm run load:read` | GET 게시글 목록 |
| `npm run load:create` | POST 글작성 |
| `npm run load:login` | POST 로그인 |
| `npm run load:ratelimit` | 429 경계 |

프로파일/규모: `PROFILE=load VUS=20 k6 run load/scenarios/read-posts.js`

## rate limit 주의
부하가 rate limit에 걸리므로, 측정 시 한도를 크게 띄운다:
`RATE_LIMIT_USER_MAX=100000 RATE_LIMIT_IP_MAX=100000 node dist/main.js`
rate-limit 시나리오는 반대로 낮은 한도로 띄워 429를 검증한다.

## 결과 기록
| 일자 | 시나리오 | 프로파일 | p95(ms) | RPS | 에러율 | 비고 |
|---|---|---|---|---|---|---|
| _(측정 후 기록)_ | | | | | | |
