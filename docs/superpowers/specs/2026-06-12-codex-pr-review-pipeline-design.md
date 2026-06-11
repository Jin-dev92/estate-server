# Codex PR 자동 리뷰 파이프라인 설계

- 작성일: 2026-06-12
- 대상 레포: `Jin-dev92/estate-server-kafka` (NestJS)
- 상태: 승인됨 → 구현 계획 단계로 진행

## 1. 목표 (What / Why)

PR이 **리뷰 가능한 상태(non-draft)**가 되는 순간, GitHub 클라우드에서
OpenAI Codex가 자동으로 코드 리뷰를 수행하고 결과를 PR에 요약 코멘트로
남긴다. 내 PC가 켜져 있지 않아도 동작하는 서버사이드 파이프라인이다.

성공 기준:
- draft PR에는 리뷰가 돌지 않는다.
- non-draft로 열리거나 draft→ready 전환 시 정확히 1회 리뷰가 돈다.
- 리뷰 결과가 PR에 요약 코멘트 1개로 게시된다.
- 리뷰는 비차단(informational)이다 — 머지를 막지 않는다.
- 리뷰 기준에 프로젝트 보안 원칙(RLS / rate limit / API 키 노출 / RBAC)이
  포함되어 매 PR 자동 점검된다.

## 2. 결정 사항 (확정)

| 항목 | 결정 |
|---|---|
| 실행 위치 | GitHub 클라우드 네이티브 |
| 방식 | GitHub Actions + codex CLI (`codex exec`) |
| 인증 | GitHub Secret `OPENAI_API_KEY` (토큰 종량제) |
| 결과 표시 | PR 요약 코멘트 1개 |
| 차단 여부 | 비차단 (정보성만, Check fail 안 함) |
| 재리뷰 시점 | 최초 ready 1회만 (push마다 재리뷰 안 함) |

## 3. 전체 흐름

```
PR이 ready 상태가 됨
  ├─ 직접 non-draft로 열림  → pull_request: opened
  └─ draft → ready 전환     → pull_request: ready_for_review
        │
        ▼
  if draft == false 일 때만 잡 실행
        │
        ▼
  [checkout] → [codex CLI 설치] → [PR diff 추출]
        → [codex exec 로 리뷰 프롬프트 실행] → [요약 코멘트 1개 게시]
```

## 4. 트리거 설계

```yaml
on:
  pull_request:
    types: [opened, ready_for_review]
```

- `opened`은 draft로 열린 PR도 포함되므로, 잡 레벨에서
  `if: github.event.pull_request.draft == false`로 한 번 더 거른다.
- `ready_for_review`가 "draft→리뷰 전환" 케이스를 잡는다.
- `synchronize`(push)는 **넣지 않는다** → "최초 ready 때만" 요구사항대로 토큰 절약.
- **보안상 `pull_request_target`은 사용하지 않는다.** 그 이벤트는 base 브랜치
  코드를 시크릿과 함께 실행해 시크릿 탈취 위험이 있다. 안전한 `pull_request` 사용.

## 5. 구성 요소

| 파일 / 리소스 | 역할 |
|---|---|
| `.github/workflows/codex-review.yml` | 워크플로 정의 (트리거·잡·스텝) |
| `.github/codex/review-prompt.md` | 리뷰 기준 프롬프트. 프로젝트 보안 원칙(RLS / rate limit / API 키 노출 / RBAC)을 명시적으로 주입. 레포에 버전 관리되어 언제든 수정 가능 |
| GitHub Secret `OPENAI_API_KEY` | codex CLI 인증. 로그에 절대 노출 금지 |

## 6. 잡 스텝 (개념 수준)

1. `actions/checkout` — base/head diff를 위해 충분한 history fetch.
2. Node 셋업 + codex CLI 설치.
3. `gh pr diff`로 변경분(diff) 추출.
4. `codex exec`를 **읽기 전용(read-only sandbox)**으로 실행 — 리뷰 프롬프트 +
   diff 입력. 코드 수정 금지. 리뷰 텍스트만 stdout으로 받는다.
5. `gh pr comment`로 요약 코멘트 1개 게시 (비차단 — Check fail 안 함).

권한은 최소로: `permissions: { contents: read, pull-requests: write }`.

## 7. 에러 / 엣지 처리

- **codex 실행 실패** → 잡은 성공(비차단 원칙)으로 끝내되, "리뷰 생성 실패"
  코멘트를 남겨 사람이 인지하도록 한다.
- **중복 실행** → `concurrency` 그룹으로 같은 PR의 이전 실행을 취소한다.
- **fork PR** → `pull_request` 이벤트는 fork에 시크릿을 주지 않는다. 개인
  레포라 보통 무관하지만, 외부 기여 PR은 리뷰가 스킵될 수 있음을 문서에 명시.
- **비용/토큰 폭탄 방지** → ready 1회만 실행 + diff만 전달(레포 전체 X).
  프로젝트의 rate-limit 원칙과 동일 맥락.

## 8. 구현 단계에서 검증 필요 (설계에서 확정 못 하는 것)

- codex CLI의 정확한 패키지명 / `exec` 플래그(read-only sandbox 지정, 모델
  지정, stdin/인자 입력 방식)는 구현 시 실제 설치 버전으로 검증한다.
- `gh pr comment` 사용 시 동일 PR에 코멘트 누적 vs 갱신(upsert) 여부 결정.

## 9. 범위 밖 (YAGNI)

- 인라인 리뷰 코멘트(라인별) — 이번엔 요약 코멘트 1개만.
- 머지 차단(required check) — 비차단으로 결정.
- push마다 재리뷰 — 최초 ready 1회만.
- OpenAI 네이티브 GitHub 리뷰(Option A) — 채택 안 함.
