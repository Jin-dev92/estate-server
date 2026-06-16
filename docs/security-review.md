# 보안 점검 (M6)

> 점검일: 2026-06-15 · 대상: estate-server (M0~M6) · 기준: CLAUDE.md 보안 원칙
> 방법: 컨트롤러/유스케이스/인프라 코드를 직접 확인(grep + 파일 검사). 추측 없이 코드 근거로 판정.

## 요약

**크리티컬 구멍 없음.** 모든 쓰기 라우트가 인증 가드와 역할·소유권 검사를 갖추고 있으며, 민감정보는 환경변수로만 접근하고 `.env`는 gitignore 대상이다. 운영 배포 단계에서 챙겨야 할 **권고 2건**(프록시 IP 신뢰, 카운터 Redis eviction)만 후속 과제로 남긴다.

| # | 항목 | 현황(근거) | 판정 | 조치 |
|---|------|-----------|------|------|
| 1 | RBAC + 리소스 소유권 우회 | property 쓰기는 `@UseGuards(JwtAuthGuard, RolesGuard)` + `@Roles(Role.OWNER)` + `NOT_BUILDING_OWNER`(create-unit) 검사. board는 `@UseGuards(JwtAuthGuard)` 클래스 + 작성자 검사(`NOT_AUTHOR`: update/delete-post)·멤버십(`isMember`: create-post/comment/list/get). chat은 `isParticipant`/`ensure-room` 소유·멤버 검사. notification은 `user.sub` 기준 본인 데이터만. | **OK** | 없음 |
| 2 | 인가 가드 누락 | 전 컨트롤러의 쓰기 라우트에 `JwtAuthGuard` 적용 확인. `auth`의 `signup`/`login`만 공개(의도된 미인증). `me`는 가드 있음. 미인증 쓰기 = 회원가입/로그인뿐이며 M6에서 IP rate limit(`ipMax:10`)으로 보강. | **OK** | 없음 |
| 3 | 시크릿 노출(env·로그·에러) | 민감값(JWT/DB/Redis/Kafka)은 모두 `ConfigKey`(env) 경유. 코드의 직접 `process.env`는 `NODE_ENV`·`PORT`(비민감)뿐. `.gitignore`에 `.env*` 포함. 에러 봉투/로그에 시크릿 미포함. | **OK** | 없음 |
| 4 | 에러 정보 노출(500 마스킹) | `AllExceptionsFilter`가 미지의 예외를 `COMMON_INTERNAL_ERROR`(일반 메시지)로 마스킹하고 스택은 **서버 로그에만** 기록(`logger.error`). 내부 구조/스택이 응답에 노출되지 않음. | **OK** | 없음 |
| 5 | rate limit 이중 제한 | M6: `RateLimitGuard`(전역)가 쓰기(POST/PATCH/PUT/DELETE)에 userId+IP 이중 적용, 초과 시 429 봉투 + `Retry-After`. 로그인/회원가입은 `@RateLimit({ ipMax: 10 })`로 강화. 스모크: login 11회 중 11번째 429 확인. | **OK** | 없음 |
| 6 | 토큰 만료·초대코드 단일사용 | JWT는 `expiresIn = ConfigKey.JwtExpiresIn`(기본 `1h`)로 만료 설정. 초대코드는 `set(... 'EX', INVITE_TTL_SEC)`(TTL) + `getdel`(읽고 즉시 삭제 = 원자적 단일 사용). | **OK** | 없음 |

## 발견 및 조치

- **크리티컬/실위험 발견: 없음.** 각 마일스톤이 가드·소유권 검사를 의도적으로 내장해 왔고, 이번 점검에서 우회 경로·가드 누락·시크릿 노출은 확인되지 않았다. 따라서 이번 PR의 코드 수정은 없다(억지 수정 금지 원칙).
- **개선(이미 반영):** M6 rate limit으로 미인증 엔드포인트(로그인·회원가입)의 브루트포스/스팸 표면을 줄였다.

## 후속 과제 (운영 단계 권고)

1. **프록시 뒤 IP 신뢰** — 현재 rate limit은 `req.ip`를 쓴다. 운영에서 LB/프록시 뒤에 두면 모든 요청이 프록시 IP로 보여 IP 한도가 전체 사용자에게 공유된다. 배포 시 `app.set('trust proxy', <신뢰 프록시>)`를 설정해 실제 클라이언트 IP를 쓰되, 스푸핑 방지를 위해 **신뢰 프록시 범위만** 지정한다.
2. **미읽음/카운터 Redis eviction** — rate limit·미읽음 카운터 키는 비정규화 카운터다. eviction 정책이 있는 캐시 인스턴스에 두면 카운트가 유실될 수 있으므로 **no-eviction(또는 별도 논리 DB)** 인스턴스를 사용한다.
3. **(범위 밖) DDoS** — 앱 레벨 rate limit은 단일 출처 남용·브루트포스를 막을 뿐, 분산 디도스는 CDN/WAF/네트워크 계층의 일이다(상호보완).
4. **(범위 밖) dual-write 이벤트 유실** — Transactional Outbox는 별도 사이클에서 해소.
