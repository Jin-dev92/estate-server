#!/usr/bin/env bash
#
# 로컬 codex 리뷰 → PR 생성/갱신 → 리뷰를 PR 코멘트로 게시
#
# [왜 로컬인가]
# 이 프로젝트는 학습용이라, PR 리뷰를 GitHub Actions(OpenAI API 종량제) 대신
# 로컬 codex로 수행한다. 로컬 codex는 ChatGPT 구독 인증을 쓰므로 추가 비용이 없다.
# (CI 리뷰는 .github/workflows/codex-review.yml 에 비활성 상태로 보존돼 있으며,
#  상업화 단계에서 결제된 OPENAI_API_KEY 를 붙이면 자동 리뷰로 전환된다.)
#
# [사용법]
#   feature 브랜치에서:  ./scripts/review-and-pr.sh [base-branch]
#   base-branch 기본값:  main
#
# [동작]
#   1) base 대비 현재 브랜치의 변경분(diff) 추출
#   2) 로컬 codex exec 로 리뷰 (보안 리뷰 프롬프트 적용, 읽기 전용)
#   3) 브랜치 push + PR 생성(없으면) 또는 기존 PR 사용
#   4) 리뷰 결과를 PR 코멘트로 게시 (비차단 — PR 생성을 막지 않음)
#
set -euo pipefail

BASE="${1:-main}"
ROOT="$(git rev-parse --show-toplevel)"
BRANCH="$(git branch --show-current)"
PROMPT_FILE="$ROOT/.github/codex/review-prompt.md"

# --- 사전 점검 ---------------------------------------------------------------
if [ "$BRANCH" = "$BASE" ] || [ -z "$BRANCH" ]; then
  echo "❌ feature 브랜치에서 실행하세요 (현재: '${BRANCH:-detached}', base: '$BASE')." >&2
  exit 1
fi
if [ ! -f "$PROMPT_FILE" ]; then
  echo "❌ 리뷰 프롬프트가 없습니다: $PROMPT_FILE" >&2
  exit 1
fi
if ! codex login status >/dev/null 2>&1; then
  echo "❌ codex 로그인이 필요합니다. 먼저 'codex login' (ChatGPT 인증) 하세요." >&2
  exit 1
fi
if ! command -v gh >/dev/null 2>&1; then
  echo "❌ gh CLI 가 필요합니다." >&2
  exit 1
fi

# --- 1) diff 추출 ------------------------------------------------------------
echo "▶ '$BASE' 대비 '$BRANCH' 변경분 추출 중..."
git fetch -q origin "$BASE" 2>/dev/null || true
if git rev-parse -q --verify "origin/$BASE" >/dev/null; then
  DIFF_RANGE="origin/$BASE...HEAD"
else
  DIFF_RANGE="$BASE...HEAD"
fi
DIFF="$(git diff "$DIFF_RANGE")"
if [ -z "$DIFF" ]; then
  echo "❌ '$BASE' 대비 변경분이 없습니다." >&2
  exit 1
fi

# --- 2) 로컬 codex 리뷰 ------------------------------------------------------
echo "▶ codex 리뷰 실행 중 (로컬, ChatGPT 인증, 읽기 전용)..."
REVIEW_FILE="$(mktemp)"
COMMENT_FILE="$(mktemp)"
trap 'rm -f "$REVIEW_FILE" "$COMMENT_FILE"' EXIT

# 보안 리뷰 프롬프트를 인자로, diff 는 stdin 으로 전달
# (codex exec 는 piped stdin 을 <stdin> 블록으로 프롬프트에 덧붙인다)
if ! printf '%s\n' "$DIFF" | codex exec \
    --sandbox read-only \
    -o "$REVIEW_FILE" \
    "$(cat "$PROMPT_FILE")"; then
  echo "❌ codex 리뷰 실행에 실패했습니다." >&2
  exit 1
fi
if [ ! -s "$REVIEW_FILE" ]; then
  echo "❌ 리뷰 결과가 비어 있습니다." >&2
  exit 1
fi

# --- 3) PR 생성 / 갱신 -------------------------------------------------------
echo "▶ '$BRANCH' push..."
git push -q -u origin "$BRANCH"
if gh pr view "$BRANCH" >/dev/null 2>&1; then
  echo "▶ 기존 PR 사용 — 리뷰 코멘트를 추가합니다."
else
  echo "▶ PR 생성..."
  gh pr create --base "$BASE" --head "$BRANCH" --fill
fi

# --- 4) 리뷰를 PR 코멘트로 게시 ----------------------------------------------
{
  echo "## 🤖 Codex 로컬 리뷰 (ChatGPT 인증)"
  echo
  echo "> 학습용 프로젝트라 리뷰를 로컬 codex 로 수행합니다. 상업화 후 CI 자동 리뷰(API 결제)로 전환 예정."
  echo
  cat "$REVIEW_FILE"
} > "$COMMENT_FILE"
gh pr comment "$BRANCH" --body-file "$COMMENT_FILE"

echo "✅ 완료: PR 에 리뷰 코멘트를 게시했습니다."
