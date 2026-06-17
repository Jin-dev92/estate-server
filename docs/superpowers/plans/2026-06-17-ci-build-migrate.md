# CI(build/typecheck + Prisma drift + 버전 범프) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PR(base dev·main)에서 `nest build`(타입체크)와 Prisma 마이그레이션 정합성(drift)을 검증하는 CI 게이트, 그리고 커밋 타입으로 `package.json` 버전을 올려 PR을 제안하는 수동 버전 범프 워크플로를 추가한다.

**Architecture:** `.github/workflows/ci.yml`(PR 트리거, build·migrations 두 병렬 잡) + `.github/workflows/version-bump.yml`(수동 트리거) + `scripts/bump-version.sh`(버전 산정·갱신). 봇 토큰 없이 기본 `GITHUB_TOKEN`만 사용.

**Tech Stack:** GitHub Actions, Node 20, Prisma(`migrate deploy`/`migrate diff`), PostgreSQL service container, bash. 코드 단위테스트가 아니라 **YAML 문법 검증 + 로컬 명령 예행 + PR 실제 실행**으로 검증한다.

> 설계 근거: [CI 설계 스펙](../specs/2026-06-17-ci-build-migrate-design.md)

---

## 사전 지식 (실행자가 알아야 할 것)

- **트리거 정책:** CI 게이트는 `pull_request`(base `dev`·`main`)에서만 — 머지 전 검증. 버전 범프는 `workflow_dispatch`(수동)만.
- **이 프로젝트는 Prisma.** 마이그레이션은 `prisma/migrations/<timestamp>_<name>/migration.sql`. drift = "`schema.prisma`는 바꿨는데 마이그레이션을 안 만든" 상태 → `prisma migrate diff … --exit-code`로 감지.
- **로컬 PG는 5433 매핑**(호스트 충돌 회피)이지만 **CI 서비스 컨테이너는 5432** 그대로 쓴다.
- **커밋 컨벤션:** 제목 `[티켓]기능: 설명`, 기능 ∈ `feat|fix|refactor|docs|test|chore|style`. 버전 산정: `feat|refactor`→minor, 그 외→patch.
- **봇 토큰 미사용:** 보호 안 된 `chore/version-bump-*` 브랜치 push + `gh pr create`는 `GITHUB_TOKEN`(`contents:write`+`pull-requests:write`)로 충분. *트레이드오프:* GITHUB_TOKEN이 만든 PR은 CI를 자동 트리거하지 않음(범프 PR 체크는 수동 재실행).
- **검증 환경:** `docker compose`(PG·Redis·Kafka)·`node`·`python3`는 로컬에 있음. `act`(로컬 Actions 러너)는 없다고 가정 — YAML 문법은 `python3 -c "import yaml; yaml.safe_load(...)"`로, 동작은 PR에서 확인.

---

## File Structure

- **Create:** `.github/workflows/ci.yml` — PR 게이트(build·migrations 잡)
- **Create:** `scripts/bump-version.sh` — 커밋 타입 → 버전 산정·`package.json` 갱신
- **Create:** `.github/workflows/version-bump.yml` — 수동 버전 범프(스크립트 실행 → PR 생성)
- **Modify:** `README.md` — 마일스톤 표 CI 항목 + 실행 방법 한 줄
- **Modify:** `docs/study/마일스톤-학습-노트.md` — CI 소절
- **Modify:** `docs/study/용어집.md` — CI/CD 용어

---

## Task 1: ci.yml — build (typecheck) 잡

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: ci.yml 생성 (build 잡)**

`.github/workflows/ci.yml`:

```yaml
name: CI

on:
  pull_request:
    branches: [dev, main]

concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  build:
    name: build (typecheck)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - name: Install deps
        run: npm ci
      - name: Generate Prisma Client
        run: npx prisma generate
      - name: Build (tsc typecheck)
        run: npm run build
```

- [ ] **Step 2: YAML 문법 검증**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml')); print('YAML OK')"`
Expected: `YAML OK` (에러 없음).

- [ ] **Step 3: build 단계 로컬 예행**

Run: `npm ci && npx prisma generate && npm run build`
Expected: exit 0 (CI의 build 잡과 동일 명령이 로컬에서 성공).

- [ ] **Step 4: 커밋**

```bash
git add .github/workflows/ci.yml
git commit -m "[CI]feat: PR build/typecheck 워크플로 추가

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: ci.yml — migrations (Prisma drift) 잡

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: migrations 잡 추가**

`.github/workflows/ci.yml`의 `jobs:` 아래(build 잡 다음)에 `migrations` 잡을 추가한다. 파일 전체가 아래가 되도록 한다:

```yaml
name: CI

on:
  pull_request:
    branches: [dev, main]

concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  build:
    name: build (typecheck)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - name: Install deps
        run: npm ci
      - name: Generate Prisma Client
        run: npx prisma generate
      - name: Build (tsc typecheck)
        run: npm run build

  migrations:
    name: migrations (prisma drift)
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: estate
          POSTGRES_PASSWORD: estate
          POSTGRES_DB: estate
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U estate"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10
    env:
      DATABASE_URL: postgresql://estate:estate@localhost:5432/estate?schema=public
      SHADOW_DATABASE_URL: postgresql://estate:estate@localhost:5432/estate_shadow?schema=public
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - name: Install deps
        run: npm ci
      - name: Create shadow database (for migrate diff)
        run: PGPASSWORD=estate psql -h localhost -U estate -d estate -c "CREATE DATABASE estate_shadow;"
      - name: Apply migrations to a fresh DB
        run: npx prisma migrate deploy
      - name: Check schema vs migrations drift
        run: |
          npx prisma migrate diff \
            --from-migrations ./prisma/migrations \
            --to-schema-datamodel ./prisma/schema.prisma \
            --shadow-database-url "$SHADOW_DATABASE_URL" \
            --exit-code
```

> `psql`은 GitHub `ubuntu-latest` 러너에 기본 설치돼 있다. shadow DB를 미리 만들어야 `migrate diff --from-migrations`가 그 DB에 마이그레이션을 재생해 datamodel과 비교할 수 있다.

- [ ] **Step 2: YAML 문법 검증**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml')); print('YAML OK')"`
Expected: `YAML OK`.

- [ ] **Step 3: migrations 단계 로컬 예행 (docker)**

인프라를 띄우고(로컬 PG는 5433), CI와 같은 두 명령을 예행한다:

```bash
docker compose up -d
PGPASSWORD=estate psql -h localhost -p 5433 -U estate -d estate -c "DROP DATABASE IF EXISTS estate_shadow;" -c "CREATE DATABASE estate_shadow;"
DATABASE_URL="postgresql://estate:estate@localhost:5433/estate?schema=public" npx prisma migrate deploy
npx prisma migrate diff \
  --from-migrations ./prisma/migrations \
  --to-schema-datamodel ./prisma/schema.prisma \
  --shadow-database-url "postgresql://estate:estate@localhost:5433/estate_shadow?schema=public" \
  --exit-code; echo "diff exit=$?"
```
Expected: `migrate deploy`가 성공하고, `migrate diff … --exit-code`가 **exit 0**(현재 schema.prisma ↔ 마이그레이션 일치). exit가 2면 실제 drift가 있다는 뜻이니 그 경우 보고한다(이 PR 범위에선 일치해야 정상).

- [ ] **Step 4: 커밋**

```bash
git add .github/workflows/ci.yml
git commit -m "[CI]feat: PR Prisma 마이그레이션 정합성(drift) 검증 잡 추가

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: scripts/bump-version.sh — 버전 산정 스크립트

**Files:**
- Create: `scripts/bump-version.sh`

- [ ] **Step 1: 스크립트 작성**

`scripts/bump-version.sh`:

```bash
#!/bin/bash
# 커밋 타입으로 package.json 버전을 산정·갱신한다.
# 우리 커밋 컨벤션: "[티켓]기능: 설명" (기능 ∈ feat|fix|refactor|docs|test|chore|style).
#   - feat|refactor 가 하나라도 있으면 → minor++ (patch=0)
#   - 그 외(fix|docs|test|chore|style)만 있으면 → patch++
#   - 둘 다 없으면 → 범프 안 함(출력 없이 종료)
# major는 자동 범위 밖(수동). git commit/push/PR은 워크플로가 담당(이 스크립트는 계산+갱신만).
set -e

CURRENT=$(node -p "require('./package.json').version")
echo "현재 버전: $CURRENT"
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"

# 마지막 버전 범프 커밋 이후의 커밋만 분석(없으면 전체 분석)
LAST_BUMP=$(git log --grep="버전 범프" --format="%H" -n 1 || echo "")
if [ -z "$LAST_BUMP" ]; then
  COMMITS=$(git log --format="%s" --no-merges)
else
  COMMITS=$(git log "${LAST_BUMP}..HEAD" --format="%s" --no-merges)
fi

HAS_FEATURE=false
HAS_PATCH=false
while IFS= read -r msg; do
  [ -z "$msg" ] && continue
  # "[티켓]" prefix(공백 유무 모두) 허용
  if [[ $msg =~ ^(\[[^]]*\])?[[:space:]]*(feat|refactor): ]]; then
    HAS_FEATURE=true
  elif [[ $msg =~ ^(\[[^]]*\])?[[:space:]]*(fix|docs|test|chore|style): ]]; then
    HAS_PATCH=true
  fi
done <<< "$COMMITS"

if [ "$HAS_FEATURE" = true ]; then
  MINOR=$((MINOR + 1)); PATCH=0
  echo "feat/refactor 감지 → MINOR 증가"
elif [ "$HAS_PATCH" = true ]; then
  PATCH=$((PATCH + 1))
  echo "fix/그 외 감지 → PATCH 증가"
else
  echo "범프할 커밋 없음(대상 타입 없음)"; exit 0
fi

NEW="$MAJOR.$MINOR.$PATCH"
echo "새 버전: $CURRENT → $NEW"
npm pkg set version="$NEW"

# 워크플로가 읽을 출력
if [ -n "$GITHUB_OUTPUT" ]; then
  echo "new_version=$NEW" >> "$GITHUB_OUTPUT"
fi
echo "new_version=$NEW" > /tmp/version_bump_output.txt
```

- [ ] **Step 2: 실행 권한 부여**

Run: `chmod +x scripts/bump-version.sh`

- [ ] **Step 3: 로컬 예행(dry-run 후 되돌리기)**

Run:
```bash
bash scripts/bump-version.sh
echo "--- package.json version ---"; node -p "require('./package.json').version"
git checkout package.json   # 로컬 변경 되돌림(실제 범프는 워크플로에서)
```
Expected: 현재 `0.0.1`에서 그동안의 커밋에 feat/refactor가 있어 **`0.1.0`으로 산정**되고 "새 버전: 0.0.1 → 0.1.0" 출력. 이후 `git checkout`으로 package.json 원복.

- [ ] **Step 4: 커밋**

```bash
git add scripts/bump-version.sh
git commit -m "[CI]feat: 커밋 타입 기반 버전 산정 스크립트(bump-version.sh)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: version-bump.yml — 수동 버전 범프 워크플로

**Files:**
- Create: `.github/workflows/version-bump.yml`

- [ ] **Step 1: 워크플로 작성**

`.github/workflows/version-bump.yml`:

```yaml
name: Version Bump (Manual)

on:
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write

jobs:
  version-bump:
    name: Bump version & open PR
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: dev
          fetch-depth: 0 # 커밋 이력 분석에 전체 히스토리 필요
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: Compute & apply version bump
        id: bump
        run: |
          chmod +x scripts/bump-version.sh
          ./scripts/bump-version.sh
      - name: Create version bump PR
        if: steps.bump.outputs.new_version != ''
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          NEW="${{ steps.bump.outputs.new_version }}"
          BRANCH="chore/version-bump-${NEW}"
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git checkout -b "$BRANCH"
          git add package.json
          git commit -m "chore: 버전 범프 v${NEW} [skip ci]" || { echo "변경 없음"; exit 0; }
          git push origin "$BRANCH"
          gh pr create --base dev --head "$BRANCH" \
            --title "chore: 버전 범프 v${NEW}" \
            --body "커밋 타입으로 산정한 버전 범프입니다. 새 버전: \`${NEW}\`. (feat·refactor→minor, 그 외→patch)"
```

> `git push`는 checkout가 심은 `GITHUB_TOKEN`으로 보호 안 된 새 브랜치에 push(가능). `gh pr create`는 `GH_TOKEN=GITHUB_TOKEN`으로 동작. 봇 PAT 불필요.

- [ ] **Step 2: YAML 문법 검증**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/version-bump.yml')); print('YAML OK')"`
Expected: `YAML OK`.

- [ ] **Step 3: 커밋**

```bash
git add .github/workflows/version-bump.yml
git commit -m "[CI]feat: 수동 버전 범프 워크플로(workflow_dispatch → dev PR)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: 문서

**Files:**
- Modify: `README.md`, `docs/study/마일스톤-학습-노트.md`, `docs/study/용어집.md`

- [ ] **Step 1: README 마일스톤 표 CI 항목 갱신**

`README.md` 마일스톤 표에서 `| **CI** *(예정)*` 행을 아래로 바꾼다:
```markdown
| **CI** 🟡 | PR 게이트(build·typecheck + Prisma drift) + 수동 버전 범프 | GitHub Actions·서비스 컨테이너·migrate diff |
```
(🟡 = 1단계 완료, 부하 smoke·lint·test·CD는 후속.) 표 아래 "CI (통합)" 설명 문단에 한 줄 추가:
```markdown
> **1단계 구현:** `ci.yml`이 PR(→dev·main)에서 `nest build`(타입체크)와 Prisma 마이그레이션 drift(`migrate diff --exit-code`)를 검증한다. `version-bump.yml`(수동)은 커밋 타입으로 `package.json` 버전을 올려 dev로 PR을 연다. 부하 smoke·lint·test·CD는 후속 단계.
```

- [ ] **Step 2: 학습 노트 CI 소절 추가**

`docs/study/마일스톤-학습-노트.md` §0 마일스톤 표의 M10 행 아래에 추가:
```markdown
| **CI** | PR 게이트 + 버전 범프 | GitHub Actions, service container, prisma migrate diff(drift), 커밋 타입 기반 버전 산정 |
```
그리고 문서 끝부분(§9 테스트 전략 앞 또는 §8.6 뒤)에 소절 추가:
```markdown
## 8.7 CI — PR 게이트 + 버전 범프

### 개념
- **PR 게이트:** 머지 전 `pull_request`에서 자동 검증. 우리는 ① `nest build`(타입체크 — 컴파일 에러를 사람보다 먼저 잡음) ② Prisma **drift 체크**.
- **Prisma drift:** `migrate deploy`(빈 DB에 마이그레이션이 깨끗이 적용되나) + `migrate diff --from-migrations … --to-schema-datamodel … --exit-code`(schema.prisma ↔ 마이그레이션 일치 — "스키마만 바꾸고 마이그레이션 누락"을 비0 종료로 차단). CLAUDE.md DB 룰을 CI가 강제.
- **service container:** Actions가 잡과 함께 띄우는 일회용 의존(여기선 postgres:16). `localhost:5432`로 접근, 자격증명은 throwaway라 시크릿 불필요.
- **버전 범프:** 수동(`workflow_dispatch`). 커밋 타입(feat·refactor→minor, 그 외→patch)으로 다음 버전을 산정해 `package.json`을 올리고 **dev로 PR 제안**. 보호 브랜치에 직접 push하지 않아 봇 PAT 불필요.

### 트레이드오프
- **GITHUB_TOKEN ↔ PAT:** 기본 토큰은 안전(권한 좁음)하지만 그게 만든 PR은 CI를 자동 트리거하지 않는다 → 범프 PR 체크는 수동 재실행. 자동화하려면 PAT(진짜 secret) 필요.
- **단계적 확장:** 가성비 높은 게이트(build·drift)부터, 부하 smoke·lint·test·CD는 같은/별 워크플로로 점증.

### 스스로 점검
- [ ] `migrate diff --exit-code`가 "스키마 변경 후 마이그레이션 누락"을 어떻게 비0 종료로 잡나?
- [ ] GITHUB_TOKEN으로 만든 PR이 왜 CI를 자동 트리거하지 않나? 언제 PAT가 필요한가?
```

- [ ] **Step 3: 용어집 CI 용어 추가**

`docs/study/용어집.md`의 "## 7.5 관측성" 섹션 뒤(또는 적절한 위치)에 추가:
```markdown
## 7.6 CI/CD (CI)

- **CI (지속적 통합):** 변경을 자주 병합하며 **자동 검증**(빌드·테스트·정합성)하는 것. *우리:* PR에서 build·migrate drift 검증.
- **GitHub Actions:** GitHub의 워크플로 자동화. `.github/workflows/*.yml`. 트리거(`pull_request`·`workflow_dispatch`) → 잡(러너에서 실행).
- **service container:** 잡과 함께 띄우는 일회용 의존 컨테이너(예: postgres). 테스트에 실제 DB를 붙일 때 사용, 끝나면 폐기.
- **required status check:** branch protection에서 "이 체크가 green이어야 머지 가능"으로 지정한 CI 잡.
- **prisma migrate diff (drift 감지):** 마이그레이션을 적용한 상태와 `schema.prisma`의 차이를 계산. `--exit-code`면 차이 있을 때 비0 → CI red.
- **GITHUB_TOKEN vs PAT:** Actions 기본 토큰(자동·권한 좁음, 보호 브랜치 우회·워크플로 재트리거 불가) ↔ PAT/App 토큰(사람이 발급한 강력 secret, 우회·재트리거 가능).
```

- [ ] **Step 4: 커밋**

```bash
git add README.md docs/study/마일스톤-학습-노트.md docs/study/용어집.md
git commit -m "[CI]docs: README·학습 노트·용어집에 CI(게이트+버전 범프) 반영

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## 완료 기준 (전체 검증)
- [ ] 두 워크플로 YAML이 문법상 유효(`yaml.safe_load` 통과).
- [ ] `npm ci && npx prisma generate && npm run build`가 로컬에서 exit 0(= build 잡 재현).
- [ ] 로컬 docker로 `migrate deploy` + `migrate diff --exit-code`가 exit 0(= migrations 잡 재현, drift 없음).
- [ ] `bump-version.sh`가 커밋 타입대로 버전을 산정(현재 0.0.1 → feat 있으면 0.1.0)하고 package.json을 갱신(로컬 예행 후 원복).
- [ ] 문서 3종(README·학습 노트·용어집) 갱신.
- [ ] **이 PR이 열리면** ci.yml의 build·migrations 잡이 실제로 green(= CI 자체 검증). *(GITHUB_TOKEN/PR 트리거 특성상, 이 PR은 사람이 연 것이라 정상 트리거됨.)*

> **운영 안내(워크플로 밖):** 머지 후 GitHub 레포 설정 → branch protection(dev·main)에서 `build`·`migrations`를 required status check로 등록해야 "red면 머지 불가"가 강제된다. version-bump는 Actions 탭에서 수동 실행.
