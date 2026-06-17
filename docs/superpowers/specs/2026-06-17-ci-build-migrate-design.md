# CI — build/typecheck + Prisma 마이그레이션 정합성(drift) 게이트 (설계 스펙)

> 작성일: 2026-06-17
> 선행: CLAUDE.md "DB 형상관리(Prisma 마이그레이션) 룰", README 마일스톤 표 "CI" 항목
> 기존: `.github/workflows/codex-review.yml`(리뷰용)만 있음 — 이번이 첫 검증 CI.

---

## 1. 목적과 범위

README의 CI 마일스톤은 "부하 smoke 자동화 + 린트·테스트·빌드 등 통합"을 목표로 하지만, **한 번에 다 넣지 않고 단계적으로** 쌓는다. 이번 스펙은 **1단계: 가장 가성비 높은 두 게이트**만 다룬다.

1. **build / typecheck** — `nest build`(=tsc)로 컴파일·타입 검증. 인프라 불필요.
2. **Prisma 마이그레이션 정합성(drift) 체크** — 빈 PostgreSQL에 마이그레이션이 깨끗이 적용되는지 + `schema.prisma`와 마이그레이션 파일이 어긋나지 않는지(누락 마이그레이션) 검증.

이 둘을 고른 이유:
- **typecheck:** 최근 작업에서 컴파일 에러(SDK export·타입 불일치)를 사람이 뒤늦게 발견한 적이 있다 → CI가 PR에서 즉시 빨강으로 막는 게 가성비 최고.
- **마이그레이션 drift:** CLAUDE.md DB 룰("스키마 변경 = 코드 변경", "schema.prisma만 바꾸고 migration.sql 없이 머지 금지", "배포된 마이그레이션 수정 금지")을 **사람 점검 대신 CI가 강제**한다.

### 트리거
- `pull_request`의 **base가 `dev` 또는 `main`**일 때 실행(머지 전 게이트). feature→dev, dev→main 통합 PR 모두 커버.
- push 트리거는 두지 않는다(중복 실행 회피, 게이트 목적에 PR로 충분).

### 범위에서 제외 (후속 CI 단계)
- 부하 smoke 자동화(M7 k6, 서비스 컨테이너 PG·Redis·Kafka), 린트(eslint), 단위/e2e 테스트, 시크릿 스캔(gitleaks), 커밋 메시지 lint, CD(Docker 빌드·배포·Sentry 릴리스). — 같은 `ci.yml`에 잡을 점진 추가하거나 별 워크플로로 확장.

### 성공 기준
- PR을 열면 **build·migrations 두 잡이 자동 실행**되고, 정상 코드면 green.
- 컴파일 에러가 있으면 build 잡이 red.
- `schema.prisma`를 바꿨는데 **마이그레이션 파일을 안 만든** PR은 migrations 잡이 red(drift 감지).
- 깨진/적용 불가 마이그레이션도 migrations 잡이 red(빈 DB 적용 실패).
- 외부 시크릿 불필요(PG는 일회용 서비스 컨테이너, 자격증명은 throwaway).

---

## 2. 워크플로 구조

단일 파일 `.github/workflows/ci.yml`에 **독립 병렬 잡 2개**.

```
.github/workflows/ci.yml
├── job: build         (인프라 없음)        — nest build(tsc)
└── job: migrations    (postgres 서비스)     — prisma migrate deploy + diff(drift)
```

- 공통: `runs-on: ubuntu-latest`, Node 20(`actions/setup-node`, `cache: npm`), `npm ci`.
- `concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }` — 같은 PR에 새 푸시가 오면 이전 실행 취소(비용·시간 절감).

---

## 3. job: build (typecheck)

인프라 없이 컴파일/타입만 검증한다.

| 단계 | 명령 | 의미 |
|---|---|---|
| checkout | `actions/checkout@v4` | |
| node | `actions/setup-node@v4` (node 20, cache npm) | |
| install | `npm ci` | lockfile 그대로 설치 |
| prisma generate | `npx prisma generate` | `@prisma/client` 타입 생성(빌드가 import하므로 필수) |
| build | `npm run build` | `nest build` = tsc 컴파일 + 타입 검증 |

- `nest build`가 타입 에러 시 비0 종료 → 잡 red. 별도 `tsc --noEmit` 불필요(빌드가 곧 타입체크).

---

## 4. job: migrations (Prisma drift 게이트)

빈 PostgreSQL을 띄워 마이그레이션을 검증한다. (이전에 검토한 "pending_ 파일 rename CI"는 **Prisma가 디렉토리 타임스탬프로 순서를 자동 부여**하므로 불필요 — 대신 이 정합성 체크가 Prisma 환경에 맞는 마이그레이션 CI다.)

**서비스 컨테이너**
```yaml
services:
  postgres:
    image: postgres:16-alpine
    env: { POSTGRES_USER: estate, POSTGRES_PASSWORD: estate, POSTGRES_DB: estate }
    ports: ['5432:5432']
    options: >-
      --health-cmd "pg_isready -U estate" --health-interval 5s
      --health-timeout 5s --health-retries 10
```
> 로컬은 호스트 5432 충돌로 5433에 매핑하지만, **CI 컨테이너에선 5432 그대로** 쓴다.

**env**
- `DATABASE_URL=postgresql://estate:estate@localhost:5432/estate?schema=public`
- `SHADOW_DATABASE_URL=postgresql://estate:estate@localhost:5432/estate_shadow?schema=public` (diff용 shadow DB — Prisma가 생성/리셋, 컨테이너 superuser라 가능)

| 단계 | 명령 | 무엇을 잡나 |
|---|---|---|
| install | `npm ci` | |
| **적용 검증** | `npx prisma migrate deploy` | 빈 DB에 모든 마이그레이션이 **깨끗이 적용**되나(깨진 SQL·순서·이미 배포된 파일 변경으로 인한 실패 감지) |
| **drift 검증** | `npx prisma migrate diff --from-migrations ./prisma/migrations --to-schema-datamodel ./prisma/schema.prisma --shadow-database-url "$SHADOW_DATABASE_URL" --exit-code` | 마이그레이션을 모두 적용한 상태 ↔ 현재 `schema.prisma`가 **다르면 비0 종료** = "스키마는 바꿨는데 마이그레이션 누락" |

- `migrate diff … --exit-code`: 차이 없으면 0, 있으면 2 → 잡 red. 이게 **누락 마이그레이션의 핵심 탐지기**.
- (선택) `npx prisma validate`로 schema.prisma 문법 검증을 앞단에 더할 수 있으나, generate/deploy가 이미 사실상 검증하므로 1단계에선 생략 가능.

---

## 5. 운영 메모 (워크플로 밖)

- **필수 체크 지정:** 이 두 잡을 GitHub 레포 설정의 **branch protection → required status checks**로 등록해야 "red면 머지 불가"가 강제된다. (워크플로 파일이 아니라 레포 설정 — README/PR에 안내.)
- **시크릿 없음:** 이번 CI는 PAT·DSN·토큰이 필요 없다(서비스 컨테이너 자격증명은 워크플로에 평문 throwaway). 후속 CD 단계에서야 secret 등장.

---

## 6. 검증 방법

- **양성:** 이 변경으로 PR을 열면 build·migrations 두 잡이 **green**.
- **음성(직접 확인):**
  - `schema.prisma`에 컬럼 하나를 추가하고 마이그레이션은 안 만든 채 푸시 → migrations 잡이 **drift로 red** 확인 후 되돌린다.
  - 코드에 의도적 타입 에러를 넣어 push → build 잡 **red** 확인 후 되돌린다.
- 로컬에서 동일 명령 예행:
  ```bash
  docker compose up -d
  npx prisma migrate deploy
  npx prisma migrate diff --from-migrations ./prisma/migrations \
    --to-schema-datamodel ./prisma/schema.prisma \
    --shadow-database-url "postgresql://estate:estate@localhost:5433/estate_shadow?schema=public" --exit-code
  npm run build
  ```

---

## 7. 문서 산출물

- **README:** 마일스톤 표 `CI` 항목을 "1단계(build·migrate drift) 완료 + 후속(부하 smoke·lint·test·CD) 예정"으로 갱신. §8 실행 방법 근처에 "CI가 PR에서 build·migration drift를 검증한다" 한 줄.
- **학습 노트:** CI 소절 — typecheck 게이트의 가치(컴파일 에러 조기 차단), Prisma drift 체크가 CLAUDE.md DB 룰을 어떻게 강제하는지, service container 개념, `migrate diff --exit-code` 원리.
- **용어집:** CI/CD·GitHub Actions·service container·required status check·`migrate diff`(drift) 추가.

---

## 8. 단계별 검증(구현)

| 단계 | 산출물 | 검증 |
|---|---|---|
| 1 | `.github/workflows/ci.yml`(build 잡) | PR에서 build 잡 green, 타입 에러 시 red |
| 2 | migrations 잡(서비스 컨테이너 + deploy + diff) | 정상 PR green, 마이그레이션 누락 PR red |
| 3 | 문서(README·학습 노트·용어집) | 표·소절 갱신 |

---

## 9. 트레이드오프 메모 (학습 포인트)

- **PR 게이트 ↔ 실행 비용:** PR마다 CI를 돌리면 피드백이 빠르지만 분(minute)·러너를 쓴다. `concurrency cancel-in-progress`·npm 캐시·잡 분리(병렬)로 시간을 줄인다.
- **typecheck = build:** 별도 `tsc --noEmit` 대신 `nest build`로 겸함(빌드 산출물도 컴파일되는지까지 검증). 단 빌드는 generate가 선행돼야 한다(Prisma client 타입).
- **drift 체크 vs rename CI:** Prisma는 순서를 자동 부여하므로 "번호 rename"이 아니라 **"스키마 ↔ 마이그레이션 일치"**가 진짜 위험 지점 → `migrate diff --exit-code`로 강제. CI가 main에 되커밋(push)하지 않아 브랜치 보호·무한 트리거 문제도 없다.
- **단계적 확장:** 한 번에 모든 CI(부하·lint·test·CD)를 넣으면 디버깅·러너 비용이 커진다 → 가성비 높은 두 게이트부터, 이후 같은 파일에 잡을 점증.
