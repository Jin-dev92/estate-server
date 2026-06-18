# CI 후속 1 — lint + 단위 테스트 게이트 (설계 스펙)

> 작성일: 2026-06-18
> 선행: [CI 1단계 스펙](2026-06-17-ci-build-migrate-design.md)(build·migrate drift·버전 범프, 머지됨)
> 대상 파일: `.github/workflows/ci.yml`, `package.json`, 일부 `*.spec.ts`

---

## 1. 목적과 범위

CI 1단계(build/typecheck + Prisma drift + 버전 범프)에 이어, **PR 게이트를 lint·단위 테스트까지 확장**한다. 단계적 확장 원칙대로 이번 라운드는 **인프라가 필요 없는 정적·단위 검증만** 넣는다.

### 이번 라운드 (포함)
1. **lint 검사 게이트** — `eslint`를 *검사 전용*(–-fix 없이)으로 PR에서 실행.
2. **단위 테스트 게이트** — `jest`(현재 153개)를 PR에서 실행.
3. **선행: 기존 lint 에러 5건 수정** — 아래 §2. 안 고치면 게이트가 즉시 red.

### 범위에서 제외 (다음 라운드)
- e2e 테스트(서비스 컨테이너 PG·Redis·Kafka 필요), 부하 smoke(앱·워커·시드 기동), 시크릿 스캔, 커밋 메시지 lint, CD(Docker·배포·Sentry 릴리스).

### 성공 기준
- PR을 열면 **lint·단위 테스트가 자동 실행**되고, 정상 코드면 green.
- lint 위반(예: 사용 안 함, `any` 오용, 포맷)·단위 테스트 실패 시 **CI red** → 머지 차단(required check 등록 시).
- 기존 코드가 lint 검사(–-fix 없이)를 **통과**한다(§2 선행 수정 후).

---

## 2. 선행: 기존 lint 에러 5건 수정

현재 `lint` 스크립트는 `--fix`(자동수정 모드)라, CI용 *검사 전용*으로 돌리면 **5건이 드러난다**(jest는 lint를 안 해 `npm test`로는 안 보임). 게이트를 green으로 만들려면 먼저 고친다.

| 파일 | 규칙 | 원인 |
|---|---|---|
| `src/common/errors/all-exceptions.filter.spec.ts` (2건) | `@typescript-eslint/no-unsafe-member-access` | `(Sentry.captureException as jest.Mock).mock.calls[0][1]` 가 `any` 멤버 접근 |
| `src/common/sentry/init-sentry.spec.ts` (1건) | 〃 | `(Sentry.init as jest.Mock).mock.calls[0][0]` |
| `src/outbox/infrastructure/prisma-outbox-store.spec.ts` (1건) | 〃 | `(queryRaw as ...).mock.calls[0][0]` |
| `src/outbox/infrastructure/prisma-outbox-store.spec.ts` (1건) | `prettier/prettier` | 긴 문자열 줄바꿈 |

**수정 방침**
- `no-unsafe-member-access` 4건: `(X as jest.Mock)` 캐스팅 대신 **`jest.mocked(X)`** 를 써 타입 안전하게 `.mock.calls`에 접근(반환이 `any`가 아니게 됨). 필요한 곳만 최소 수정.
- `prettier/prettier` 1건: 해당 파일에 `prettier --write` 적용(포맷만).
- 테스트 동작·단언은 그대로(리팩터링 아님, lint 통과 목적).

---

## 3. lint 검사 스크립트

`package.json`에 **검사 전용** 스크립트를 추가한다(기존 `lint`는 dev 자동수정용으로 유지).

```json
"lint:check": "eslint \"{src,apps,libs,test}/**/*.ts\" --max-warnings 0"
```
- `--fix` 없음(CI가 코드를 고치면 안 됨), `--max-warnings 0`(경고도 실패로 — 엄격).
- 기존 `lint`(`… --fix`)는 그대로 둬 로컬에서 자동수정에 쓴다.

---

## 4. ci.yml — build 잡에 lint·test 통합 (A안)

별도 잡(npm ci 반복) 대신 **기존 `build` 잡에 step을 추가**해 한 번의 `npm ci`로 정적·단위 검증을 끝낸다(가볍게).

잡 이름을 정적 검증 묶음에 맞게 바꾸고(`checks (lint·test·build)`), step 순서:

| 순서 | 명령 | 의미 |
|---|---|---|
| 1 | `npm ci` | 의존성(기존) |
| 2 | `npx prisma generate` | `@prisma/client` 타입(빌드·테스트가 import) |
| 3 | `npm run lint:check` | eslint 검사(–-fix 없이) |
| 4 | `npm test` | jest 단위 테스트(인프라 불필요, mock) |
| 5 | `npm run build` | tsc 컴파일·타입 검증 |

- 순서: lint→test→build로 빠른 실패(가벼운 것부터). 어느 step이 비0이면 잡 red.
- `migrations` 잡은 그대로(독립 병렬).
- 단위 테스트는 외부 의존을 mock하므로 **서비스 컨테이너 불필요**.

---

## 5. 검증
- **로컬:** `npm run lint:check` exit 0(§2 수정 후), `npm test` 전부 통과, `npm run build` exit 0.
- **PR:** 이 변경으로 PR을 열면 `checks` 잡이 lint·test·build를 모두 통과(green). 일부러 lint 위반/테스트 실패를 넣으면 red 확인(되돌림).

---

## 6. 문서 산출물
- **README:** 마일스톤 표 CI 항목 설명에 "lint·단위 테스트 게이트 추가" 반영(🟡 유지, 후속은 e2e·부하·CD).
- **학습 노트:** §8.7 CI 소절에 lint/test 게이트 한 줄(정적 게이트의 가치, –-fix vs 검사 전용 구분).

---

## 7. 단계별 검증(구현)
| 단계 | 산출물 | 검증 |
|---|---|---|
| 1 | spec 5건 lint 수정 | `npm run lint:check`(임시) 통과, `npm test` 여전히 통과 |
| 2 | `lint:check` 스크립트 | `npm run lint:check` exit 0 |
| 3 | ci.yml build 잡에 lint·test step | YAML 유효, PR에서 green |
| 4 | 문서 | README·학습 노트 갱신 |

---

## 8. 트레이드오프 메모
- **`--fix` ↔ 검사 전용:** dev는 `lint`(자동수정)로 편하게, CI는 `lint:check`(고치지 않고 실패)로 엄격하게 — 역할 분리. CI가 코드를 고쳐 되커밋하는 패턴(위험·복잡)을 피한다.
- **한 잡 통합 ↔ 별도 잡:** 통합은 npm ci 1회로 가볍지만 한 step 실패 시 뒤가 안 돎(빠른 실패라 보통 이득). 병렬 granular가 필요해지면 그때 분리.
- **`--max-warnings 0`:** 경고도 막아 누적을 방지(엄격). 과하면 기준 완화 가능.
- **단계적 확장:** 인프라 불필요한 lint·test부터, e2e·부하는 서비스 컨테이너가 필요해 다음 라운드.
