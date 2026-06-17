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

# 마지막 버전 범프 커밋 이후의 커밋만 분석(없으면 전체 분석).
# 주의: 마커는 실제 범프 커밋 형식("chore: 버전 범프 v…")에 ^앵커한다.
# 그냥 "버전 범프"로 grep하면 "[CI] … 수동 버전 범프 (#23)"·스펙 커밋까지 잡혀 범위가 틀어진다.
LAST_BUMP=$(git log --grep="^chore: 버전 범프 v" --format="%H" -n 1 || echo "")
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

# 이번 버전에 포함된 변경 = 마지막 범프 이후 머지된 PR.
# squash-merge라 커밋 제목 끝에 "(#번호)"가 박히므로 그걸 가진 줄만 목록화한다.
CHANGES=$(echo "$COMMITS" | grep -E '\(#[0-9]+\)' | sed 's/^/- /' || true)
[ -z "$CHANGES" ] && CHANGES="(이전 범프 이후 머지된 PR 없음)"

# PR 본문을 파일로 작성(멀티라인은 --body-file이 escape 걱정 없이 깔끔).
cat > /tmp/version_bump_body.md <<EOF
커밋 타입으로 산정한 버전 범프입니다. **새 버전: \`$NEW\`** (feat·refactor→minor, 그 외→patch)

## 이 버전에 포함된 변경 (마지막 범프 이후 머지 PR)
$CHANGES
EOF
echo "PR 본문 작성 완료 → /tmp/version_bump_body.md"

# 워크플로가 읽을 출력
if [ -n "$GITHUB_OUTPUT" ]; then
  echo "new_version=$NEW" >> "$GITHUB_OUTPUT"
fi
echo "new_version=$NEW" > /tmp/version_bump_output.txt
