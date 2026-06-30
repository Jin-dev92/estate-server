# FE CI (lint·test·build) 설계

- 작성일: 2026-06-30
- 대상 레포: `estate-web`(FE 단독)
- 참조: `estate-server/.github/workflows/ci.yml`(checks job 패턴)

## 1. 목표

estate-web PR에서 lint·test·build를 자동 실행하는 GitHub Actions를 추가한다. 현재 estate-web엔 테스트/빌드 CI가 없어(submodule-bump 워크플로만 존재) PR이 무검증으로 머지된다.

- [ ] `pull_request: main`에서 `pnpm lint`·`pnpm test`(Vitest)·`pnpm build` 실행
- [ ] Node 버전 단일 출처 `.nvmrc`(=24, estate-server와 동일)
- [ ] 실패 시 머지 차단(체크 red)

## 2. estate-server와의 차이

estate-server `ci.yml`을 따르되 FE 특성상 3가지 다름:
- **`.nvmrc` 신설** — estate-web엔 없음. `24`로 추가(estate-server와 동일).
- **Prisma 스텝 제외** — FE엔 Prisma 없음.
- **lint 스크립트** — estate-web은 `lint`(plain `eslint`)만 있고 `lint:check`는 없음 → CI는 `pnpm lint` 사용(현 스크립트 그대로, 추가 변경 없음).

## 3. 워크플로

`estate-web/.github/workflows/ci.yml`
- `on: pull_request: branches: [main]`
- `concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }`
- 단일 job `checks (lint·test·build)`, `ubuntu-latest`:
  1. `actions/checkout@v5`
  2. `pnpm/action-setup@v4` (버전은 `package.json`의 `packageManager: pnpm@9.15.0`에서 자동)
  3. `actions/setup-node@v5` (`node-version-file: '.nvmrc'`, `cache: 'pnpm'`)
  4. `pnpm install --frozen-lockfile`
  5. `pnpm lint`
  6. `pnpm test`
  7. `pnpm build`

## 4. 범위 밖 (YAGNI)

- 배포·E2E·커버리지 게이트.
- `lint:check`(--max-warnings 0) 도입 — 현 `lint`로 충분(지금 lint 클린).
- `push: main` 트리거 — PR 가드면 충분(머지 후 build를 또 돌릴 필요 없음). submodule-bump 워크플로가 push:main을 이미 사용 중이라 역할도 분리됨.

## 5. 알려진 제약

- 이 워크플로를 "추가하는" PR 자체에선 GitHub 보안 정책상 실행되지 않을 수 있음(머지 후 다음 PR부터 작동) — estate-server CI와 동일 한계.
- `--frozen-lockfile`이므로 `pnpm-lock.yaml`이 `package.json`과 어긋나면 실패(의도 — lock 동기화 강제).
