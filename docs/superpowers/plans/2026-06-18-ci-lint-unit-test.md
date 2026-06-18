# CI 후속 1 — lint + 단위 테스트 게이트 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 기존 lint 에러 5건을 고친 뒤, PR 게이트 CI에 lint 검사·jest 단위 테스트를 추가한다(기존 `build` 잡에 통합).

**Architecture:** `lint`는 dev용(–-fix) 그대로 두고 CI용 `lint:check`(검사 전용)를 추가. `.github/workflows/ci.yml`의 `build` 잡을 `checks` 잡으로 확장해 `npm ci → prisma generate → lint:check → test → build`를 한 잡에서 순차 실행. 단위 테스트는 mock 기반이라 서비스 컨테이너 불필요.

**Tech Stack:** GitHub Actions, ESLint(+prettier), Jest, Node 24(.nvmrc). 검증은 로컬 명령 + PR 실행.

> 설계 근거: [CI 후속 1 스펙](../specs/2026-06-18-ci-lint-unit-test-design.md)

---

## 사전 지식
- 현재 `lint` 스크립트: `eslint "{src,apps,libs,test}/**/*.ts" --fix` (자동수정). CI는 코드를 고치면 안 되므로 **검사 전용** `lint:check` 별도 추가.
- jest는 lint를 안 하므로 `npm test`는 통과해도 `eslint`(–-fix 없이)는 **기존 에러 5건**을 낸다 → 먼저 수정.
- 에러 4건은 `@typescript-eslint/no-unsafe-member-access`(jest mock `.mock.calls`가 `any`). **`jest.mocked()`** 로 타입 안전 접근하면 해소. 1건은 prettier 포맷.
- `build`(nest build)는 spec 파일을 컴파일하지 않지만(tsconfig.build 제외), **jest(ts-jest)·eslint는 spec을 본다** → 수정은 jest·eslint 기준으로 검증.

---

## File Structure
- **Modify:** `src/common/errors/all-exceptions.filter.spec.ts` — jest.mocked (2곳)
- **Modify:** `src/common/sentry/init-sentry.spec.ts` — jest.mocked (1곳)
- **Modify:** `src/outbox/infrastructure/prisma-outbox-store.spec.ts` — 타입 안전 접근 + prettier 포맷
- **Modify:** `package.json` — `lint:check` 스크립트
- **Modify:** `.github/workflows/ci.yml` — `build` 잡 → `checks` 잡(lint·test step 추가)
- **Modify:** `README.md`, `docs/study/마일스톤-학습-노트.md` — 문서

---

## Task 1: 기존 lint 에러 5건 수정

**Files:** 3개 spec 파일

- [ ] **Step 1: all-exceptions.filter.spec.ts — jest.mocked 적용(2곳)**

`(Sentry.captureException as jest.Mock)` 를 `jest.mocked(Sentry.captureException)` 로 바꾼다(파일 내 2곳 동일 패턴). 즉:
```ts
    const scopeCb = jest.mocked(Sentry.captureException).mock.calls[0][1] as (
      s: unknown,
    ) => unknown;
```
(이전: `const scopeCb = (Sentry.captureException as jest.Mock).mock.calls[0][1] as (...)`)

- [ ] **Step 2: init-sentry.spec.ts — jest.mocked 적용(1곳)**

```ts
    const opts = jest.mocked(Sentry.init).mock.calls[0][0] as Record<
      string,
      unknown
    >;
```
(이전: `(Sentry.init as jest.Mock).mock.calls[0][0] as Record<...>`)

- [ ] **Step 3: prisma-outbox-store.spec.ts — 타입 안전 접근 + prettier 포맷**

(a) `no-unsafe-member-access` 줄:
```ts
    const sql = (queryRaw.mock.calls as Array<[{ sql: string }]>)[0][0].sql;
```
(이전: `const sql = (queryRaw.mock.calls[0][0] as { sql: string }).sql;`)

(b) prettier 포맷 — 바로 아래 `toContain` 긴 줄을 래핑:
```ts
    expect(sql).toContain(
      '"nextAttemptAt" IS NULL OR "nextAttemptAt" <= now()',
    );
```
(이전: `    expect(sql).toContain('"nextAttemptAt" IS NULL OR "nextAttemptAt" <= now()');`)

- [ ] **Step 4: lint 검사·테스트 통과 확인**

Run: `npx eslint "{src,apps,libs,test}/**/*.ts" --max-warnings 0`
Expected: exit 0(에러 0). 만약 `as (...)` 캐스팅에서 tsc/eslint가 "타입 변환 불가"를 내면 해당 캐스팅만 `as unknown as (...)`(이 레포의 허용 패턴)로 바꾼다.

Run: `npm test`
Expected: 전부 통과(jest.mocked는 런타임 동일이라 동작 불변).

- [ ] **Step 5: 커밋**
```bash
git add src/common/errors/all-exceptions.filter.spec.ts src/common/sentry/init-sentry.spec.ts src/outbox/infrastructure/prisma-outbox-store.spec.ts
git commit -m "[CI]fix: spec lint 에러 정리(jest.mocked·prettier) — lint 게이트 선행

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: lint:check 스크립트 추가

**Files:** `package.json`

- [ ] **Step 1: scripts에 lint:check 추가**

`package.json`의 `scripts`에서 `"lint": "eslint \"{src,apps,libs,test}/**/*.ts\" --fix",` 줄 바로 아래에 추가:
```json
    "lint:check": "eslint \"{src,apps,libs,test}/**/*.ts\" --max-warnings 0",
```

- [ ] **Step 2: 검증**

Run: `node -e "require('./package.json')"` → exit 0(JSON 유효).
Run: `npm run lint:check` → exit 0(Task 1 수정 후 통과).

- [ ] **Step 3: 커밋**
```bash
git add package.json
git commit -m "[CI]feat: lint:check 스크립트(검사 전용, --max-warnings 0) 추가

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: ci.yml — build 잡에 lint·test 통합

**Files:** `.github/workflows/ci.yml`

- [ ] **Step 1: build 잡을 checks 잡으로 확장**

`.github/workflows/ci.yml`의 `build:` 잡 블록을 아래로 교체한다(잡 키 `build`→`checks`, lint·test step 추가, 나머지 동일):
```yaml
  checks:
    name: checks (lint·test·build)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version-file: '.nvmrc'
      - name: Install deps
        run: npm ci
      - name: Generate Prisma Client
        run: npx prisma generate
      - name: Lint (check)
        run: npm run lint:check
      - name: Unit tests
        run: npm test
      - name: Build (tsc typecheck)
        run: npm run build
```
> `migrations` 잡은 그대로 둔다. 단위 테스트는 mock 기반이라 이 잡에 DB 서비스 컨테이너가 필요 없다.

- [ ] **Step 2: YAML 문법 검증**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml')); print('YAML OK')"`
Expected: `YAML OK`.

- [ ] **Step 3: checks 단계 로컬 예행**

Run: `npm ci && npx prisma generate && npm run lint:check && npm test && npm run build`
Expected: 네 단계 모두 성공(exit 0) — CI `checks` 잡과 동일 시퀀스.

- [ ] **Step 4: 커밋**
```bash
git add .github/workflows/ci.yml
git commit -m "[CI]feat: PR 게이트에 lint·단위 테스트 추가(build→checks 잡)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: 문서

**Files:** `README.md`, `docs/study/마일스톤-학습-노트.md`

- [ ] **Step 1: README CI 항목 갱신**

`README.md` 마일스톤 표의 CI 행을 아래로 바꾼다(이미 🟡):
```markdown
| **CI** 🟡 | PR 게이트(build·typecheck + Prisma drift + **lint·단위 테스트**) + 수동 버전 범프 | GitHub Actions·서비스 컨테이너·migrate diff |
```

- [ ] **Step 2: 학습 노트 §8.7에 한 줄 추가**

`docs/study/마일스톤-학습-노트.md`의 `## 8.7 CI` 소절 "개념"의 **PR 게이트** 불릿 끝에 추가:
```markdown
- **정적·단위 게이트(후속1):** `lint:check`(eslint 검사 전용, `--fix` 없이 `--max-warnings 0`)와 `jest` 단위 테스트를 PR에서 실행(`build` 잡에 통합). dev는 `lint`(자동수정), CI는 `lint:check`(고치지 않고 실패)로 역할 분리.
```

- [ ] **Step 3: 커밋**
```bash
git add README.md docs/study/마일스톤-학습-노트.md
git commit -m "[CI]docs: README·학습 노트에 lint·단위 테스트 게이트 반영

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## 완료 기준
- [ ] `npm run lint:check` exit 0(spec 5건 수정 후).
- [ ] `npm test` 전부 통과(현재 153).
- [ ] `npm run build` exit 0.
- [ ] `ci.yml` YAML 유효, `checks` 잡이 lint·test·build를 순차 실행.
- [ ] README·학습 노트 갱신.
- [ ] **이 PR이 열리면** `checks` 잡 green(= 자체 검증). lint·test가 실제로 PR에서 막아주는지 확인.

> **운영 안내:** 잡 이름이 `build (typecheck)`→`checks (lint·test·build)`로 바뀌므로, branch protection에 required check를 등록했다면 새 이름으로 갱신해야 한다(아직 미등록이면 무관).
