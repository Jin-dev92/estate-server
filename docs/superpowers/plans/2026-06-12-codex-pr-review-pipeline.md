# Codex PR Review Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PR이 non-draft(리뷰 가능) 상태가 되면 GitHub Actions에서 codex CLI가 자동으로 코드 리뷰를 수행하고 결과를 PR에 요약 코멘트 1개로 게시한다 (비차단).

**Architecture:** `pull_request: [opened, ready_for_review]` 이벤트로 트리거하고 `if: draft == false`로 거른다. runner에서 `@openai/codex` CLI를 설치·인증한 뒤 `codex exec review --base <base>`로 PR diff를 리뷰하고, 결과 파일을 `gh pr comment`로 게시한다.

**Tech Stack:** GitHub Actions, `@openai/codex` CLI (`codex exec review`), `gh` CLI, GitHub Secret `OPENAI_API_KEY`.

**검증된 CLI 사실 (실제 설치본 0.120.0 / npm 0.139.0 기준):**
- `codex exec review --base <BRANCH>` → base 브랜치 대비 변경분 리뷰. PR 리뷰에 적합.
- `codex exec review [PROMPT]` → 커스텀 리뷰 지침을 인자로 전달.
- `-o, --output-last-message <FILE>` → 최종 리뷰 메시지를 파일로 저장.
- `--dangerously-bypass-approvals-and-sandbox` → "외부에서 이미 샌드박스된 환경(=GitHub runner) 전용" 플래그. CI에서 샌드박스 중첩 실패를 피하기 위해 사용. 리뷰는 읽기 전용이라 코드 수정 위험 없음.
- 인증: `printenv OPENAI_API_KEY | codex login --with-api-key` (CI 표준 패턴).

---

## File Structure

- Create: `.github/codex/review-prompt.md` — 리뷰 기준 지침. 프로젝트 보안 원칙(RLS / rate limit / API 키 노출 / RBAC)을 명시. 버전 관리되어 언제든 수정 가능.
- Create: `.github/workflows/codex-review.yml` — 트리거·가드·인증·리뷰·코멘트 스텝.

설계 문서: `docs/superpowers/specs/2026-06-12-codex-pr-review-pipeline-design.md`

---

## Task 1: 로컬 헤드리스 스모크 테스트 (인증 + 리뷰 CLI де-리스크)

워크플로를 push하기 전에, codex가 **비대화형으로 API 키 인증 + 리뷰**를 할 수 있는지 로컬에서 먼저 확인한다. CI에서 처음 디버깅하면 느리고 토큰만 낭비된다.

**Files:** 없음 (검증 전용)

**전제:** 로컬 셸에 `OPENAI_API_KEY`가 export 되어 있어야 한다. 없으면 이 Task를 건너뛰고 Task 5(실제 PR E2E)로 검증해도 된다.

- [ ] **Step 1: API 키 환경변수 확인**

Run:
```bash
test -n "$OPENAI_API_KEY" && echo "key present" || echo "NO KEY - set OPENAI_API_KEY first"
```
Expected: `key present`

- [ ] **Step 2: 헤드리스 로그인**

Run:
```bash
printenv OPENAI_API_KEY | codex login --with-api-key && codex login status
```
Expected: 로그인 성공 메시지 + `Logged in` 류의 status 출력 (대화형 프롬프트 없이 종료).

- [ ] **Step 3: 리뷰 대상 작은 변경 만들기 (현재 feature 브랜치 위)**

Run:
```bash
printf '\n// codex smoke test line\n' >> src/main.ts
git add src/main.ts
git commit -m "chore: smoke test diff (temporary)"
```
Expected: 커밋 1개 생성.

- [ ] **Step 4: 헤드리스 리뷰 실행 → 결과 파일 확인**

Run:
```bash
codex exec review \
  --base main \
  --dangerously-bypass-approvals-and-sandbox \
  -o /tmp/codex-smoke-review.md \
  "변경분을 간단히 리뷰해줘. 한국어로." \
&& echo "---REVIEW FILE---" && cat /tmp/codex-smoke-review.md
```
Expected: 비대화형으로 완료되고 `/tmp/codex-smoke-review.md`에 리뷰 텍스트가 채워짐 (빈 파일/에러 아님). 인증·리뷰·출력 경로가 모두 동작함을 확인.

- [ ] **Step 5: 스모크 커밋 되돌리기**

Run:
```bash
git reset --hard HEAD~1
```
Expected: smoke test 커밋 제거, 워킹트리 깨끗.

> **검증 실패 시:** Step 2가 실패하면 인증 방식이 바뀐 것 → `codex login --help`로 재확인. Step 4가 샌드박스 에러면 `--dangerously-bypass-approvals-and-sandbox` 누락 여부 확인. 이 결과를 Task 3 워크플로에 반영한다.

---

## Task 2: 리뷰 프롬프트 파일 작성

리뷰 기준을 레포에 버전 관리되는 파일로 둔다. 프로젝트 보안 원칙을 명시해 매 PR 자동 점검되게 한다.

**Files:**
- Create: `.github/codex/review-prompt.md`

- [ ] **Step 1: 디렉터리 + 프롬프트 파일 생성**

`.github/codex/review-prompt.md`:
```markdown
당신은 이 NestJS 레포의 시니어 코드 리뷰어다. 아래 변경분(diff)을 리뷰하고, 한국어로 간결한 요약 리뷰를 작성하라.

## 출력 형식
1. **요약** — 변경의 의도와 전반 평가 2~3줄.
2. **발견 사항** — 심각도(critical / high / medium / low)별로 정렬. 각 항목은 `파일:라인 — 문제 — 제안` 형식.
3. **확인 권장** — 사람이 직접 판단해야 하는 항목.
발견이 없으면 그렇게 명시하라.

## 반드시 점검할 보안 원칙 (이 프로젝트 필수)
- **RLS**: Supabase/PostgreSQL 테이블에 RLS 활성화 여부. 구독 상태(subscription)와 사용량(rate_limit, api_usage)이 별도 테이블로 분리됐는지. 다른 사용자 데이터로의 우회 접근 경로가 있는지.
- **Rate Limit**: 프론트엔드에만 의존하는 rate limit이 아닌지. 백엔드에서 사용자 ID + IP 기반 이중 제한이 있는지. 사용량 과금 구조에서 스팸이 요금 폭탄으로 이어질 위험.
- **API 키 노출**: 민감한 외부 API(AI, Stripe, 이메일, 스토리지) 키가 프론트엔드/클라이언트 노출 prefix(VITE_, NEXT_PUBLIC_ 등)에 들어가지 않았는지. 민감 호출이 서버/Edge Function을 거치는지.
- **RBAC**: 역할 기반 접근 제어가 적절히 적용됐는지.

## 제약
- diff에 실제로 존재하는 변경만 근거로 삼아라. 추측은 "확인 권장"으로 분리하라.
- 코드를 수정하지 마라. 리뷰 텍스트만 출력하라.
```

- [ ] **Step 2: 파일 생성 확인**

Run:
```bash
test -f .github/codex/review-prompt.md && wc -l .github/codex/review-prompt.md
```
Expected: 파일 존재 + 줄 수 출력.

- [ ] **Step 3: 커밋**

Run:
```bash
git add .github/codex/review-prompt.md
git commit -m "feat: add codex review prompt with project security principles"
```
Expected: 커밋 1개.

---

## Task 3: GitHub Actions 워크플로 작성

**Files:**
- Create: `.github/workflows/codex-review.yml`

- [ ] **Step 1: 워크플로 파일 생성**

`.github/workflows/codex-review.yml`:
```yaml
name: Codex PR Review

on:
  pull_request:
    types: [opened, ready_for_review]

# 같은 PR에서 이전 실행이 돌고 있으면 취소
concurrency:
  group: codex-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true

# 최소 권한: 코드 읽기 + PR 코멘트 쓰기
permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    # draft PR에는 리뷰하지 않는다 (opened 이벤트는 draft도 포함되므로 여기서 거른다)
    if: github.event.pull_request.draft == false
    runs-on: ubuntu-latest
    steps:
      - name: Checkout (full history for base diff)
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install Codex CLI
        run: npm install -g @openai/codex

      - name: Authenticate Codex (headless)
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
        run: printenv OPENAI_API_KEY | codex login --with-api-key

      - name: Run Codex review
        id: review
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
        run: |
          BASE="origin/${{ github.event.pull_request.base.ref }}"
          if codex exec review \
              --base "$BASE" \
              --dangerously-bypass-approvals-and-sandbox \
              -o review-output.md \
              "$(cat .github/codex/review-prompt.md)"; then
            echo "status=ok" >> "$GITHUB_OUTPUT"
          else
            echo "status=failed" >> "$GITHUB_OUTPUT"
          fi

      - name: Post review comment
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          PR="${{ github.event.pull_request.number }}"
          if [ "${{ steps.review.outputs.status }}" = "ok" ] && [ -s review-output.md ]; then
            {
              echo "## 🤖 Codex 자동 리뷰"
              echo
              cat review-output.md
            } > comment.md
          else
            {
              echo "## 🤖 Codex 자동 리뷰"
              echo
              echo "⚠️ 리뷰 생성에 실패했습니다. Actions 로그를 확인해 주세요."
            } > comment.md
          fi
          gh pr comment "$PR" --body-file comment.md
```

설계 결정 반영 확인:
- 트리거 `opened` + `ready_for_review`, `synchronize` 없음 → "최초 ready 1회".
- `if: draft == false` → draft 제외.
- 리뷰 실패해도 잡은 성공으로 끝나고(`if` 분기로 처리) "실패" 코멘트로 사람이 인지 → 비차단.
- `pull_request` 사용(`pull_request_target` 아님) → 시크릿 탈취 위험 회피.

- [ ] **Step 2: 커밋**

Run:
```bash
git add .github/workflows/codex-review.yml
git commit -m "feat: add codex PR review workflow (non-draft, summary comment, non-blocking)"
```
Expected: 커밋 1개.

---

## Task 4: 워크플로 YAML 정적 검증

**Files:** 없음 (검증 전용)

- [ ] **Step 1: actionlint 있으면 lint, 없으면 YAML 파싱 검증**

Run:
```bash
if command -v actionlint >/dev/null 2>&1; then
  actionlint .github/workflows/codex-review.yml
else
  python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/codex-review.yml')); print('YAML OK')"
fi
```
Expected: `actionlint`이면 무에러 종료, 아니면 `YAML OK`.

> actionlint 설치가 쉬우면(`brew install actionlint`) 그걸로 검증하는 게 좋다. expression/권한/이벤트 오타까지 잡아준다.

---

## Task 5: 실제 PR로 엔드투엔드 검증 (권위 있는 테스트)

`OPENAI_API_KEY` 시크릿 등록 후, draft → ready 흐름에서 코멘트가 실제로 달리는지 확인한다.

**전제 (사람이 수행):** GitHub 레포 Settings → Secrets and variables → Actions → New repository secret 으로 `OPENAI_API_KEY` 등록. (CLI: `gh secret set OPENAI_API_KEY`)

- [ ] **Step 1: 시크릿 등록 확인**

Run:
```bash
gh secret list
```
Expected: 목록에 `OPENAI_API_KEY` 표시.

- [ ] **Step 2: 워크플로/프롬프트를 base 브랜치(main)에 머지**

> ⚠️ 중요: `pull_request` 이벤트는 **base 브랜치(main)에 있는 워크플로**를 사용한다. feature 브랜치에만 있으면 트리거되지 않는다. 따라서 먼저 이 브랜치를 PR로 올려 main에 머지해야 파이프라인이 살아난다.

Run:
```bash
git push -u origin feature/codex-pr-review-pipeline
gh pr create --fill --base main
```
이 PR을 리뷰/머지하여 워크플로를 main에 반영한다. (이 PR 자체는 워크플로가 아직 main에 없어 리뷰가 안 돌 수 있음 — 정상.)

- [ ] **Step 3: 테스트용 draft PR 생성**

Run:
```bash
git checkout main && git pull
git checkout -b test/codex-review-smoke
printf '\n// codex e2e test\n' >> src/main.ts
git add src/main.ts
git commit -m "test: trigger codex review e2e"
git push -u origin test/codex-review-smoke
gh pr create --fill --base main --draft
```
Expected: draft PR 생성. **draft 상태이므로 리뷰가 돌면 안 된다.**

- [ ] **Step 4: draft 상태에서 리뷰 미실행 확인**

Run:
```bash
sleep 20
gh run list --workflow=codex-review.yml --limit 5
```
Expected: 방금 draft PR에 대한 실행이 **없음** (draft 제외가 동작).

- [ ] **Step 5: ready 전환 → 리뷰 실행 확인**

Run:
```bash
gh pr ready   # 현재 브랜치의 PR을 ready로 전환
sleep 30
gh run list --workflow=codex-review.yml --limit 5
```
Expected: `ready_for_review` 이벤트로 워크플로 실행이 시작됨(in_progress 또는 completed).

- [ ] **Step 6: 요약 코멘트 게시 확인**

Run:
```bash
gh run watch $(gh run list --workflow=codex-review.yml --limit 1 --json databaseId -q '.[0].databaseId')
gh pr view --comments
```
Expected: 잡 성공 + PR에 "🤖 Codex 자동 리뷰" 요약 코멘트 1개 게시됨.

- [ ] **Step 7: 테스트 PR/브랜치 정리**

Run:
```bash
gh pr close test/codex-review-smoke --delete-branch
```
Expected: 테스트 PR 닫힘 + 브랜치 삭제.

> 성공 기준 최종 확인: ① draft엔 안 돌고 ② ready 전환 시 1회 돌고 ③ 요약 코멘트 1개가 달리고 ④ 잡 실패가 머지를 막지 않는다(required check 아님).

---

## Self-Review 메모

- **Spec 커버리지:** non-draft 트리거(Task 3 `if`/`types`), 1회 실행(synchronize 제외, Task 3), 요약 코멘트(Task 3 Post 스텝), 비차단(실패 분기 + required check 아님), 보안 원칙 주입(Task 2 프롬프트), fork/비용 주의(설계 문서 §7) — 모두 태스크에 매핑됨.
- **플레이스홀더:** 없음. 모든 스텝에 실제 명령/파일 내용 포함.
- **타입/이름 일관성:** `review-output.md`, `comment.md`, `steps.review.outputs.status`, `.github/codex/review-prompt.md` 명칭이 Task 3 내에서 일관.
- **알려진 잔여 리스크:** codex CLI 버전이 올라가며 `codex exec review` 플래그가 바뀔 수 있음 → Task 1 스모크 테스트로 사전 포착. 인증이 env 자동 인식으로 바뀌면 login 스텝이 불필요해질 수 있으나 현재는 명시 login이 안전.
