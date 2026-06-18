# Claude 자동 PR 리뷰 설정

> `.github/workflows/claude-review.yml` — PR마다 Claude가 우리 프로젝트 규칙에 비춰 변경분을 리뷰하고 한국어 코멘트를 남긴다.
> 원 가이드(타 프로젝트, Spring/Java)를 estate-server 스택에 맞게 각색함.

---

## 무엇을 하나

- **트리거**: `pull_request` `opened` / `ready_for_review`, base 브랜치 `dev`·`main`, 변경 경로 `src/**/*.ts`·`prisma/**`·`test/**/*.ts`.
- **동작**: `anthropics/claude-code-action@v1`이 `CLAUDE.md`·`README.md`·`docs/superpowers/specs`·`docs/study`를 읽고, 8개 관점(기능/안정성/성능/이벤트·분산/보안/테스트/품질·컨벤션/문서화)으로 리뷰 → `gh pr comment`로 등록.
- **draft PR**은 리뷰하지 않음(`draft == false`).

## 과금 — 왜 이건 켤 수 있나

- 이 워크플로는 **`CLAUDE_CODE_OAUTH_TOKEN`**(= `claude setup-token`, **Claude Pro/Max 구독**) 경로다 → OpenAI 종량제처럼 **건당 API 청구가 아니라 구독 사용량**으로 돈다.
- 그래서 OpenAI 종량제 때문에 비활성해 둔 [`codex-review.yml`](../../.github/workflows/codex-review.yml)과 달리 **활성화해도 추가 청구가 없다**(구독 사용량 한도는 소모). codex 워크플로는 상업화 대비용으로 비활성 보존.

---

## 레포 1회 선행 설정 (사용자 작업)

워크플로 파일을 추가해도 **Secret이 없으면 동작하지 않는다.** 아래를 먼저 한다.

### 1) Claude GitHub App 설치
- https://github.com/apps/claude → **Install** → 이 레포 선택.
- 권한: Contents(Read), Pull Requests(Read & Write), Issues(Read).

### 2) OAuth 토큰 발급 → Secret 등록 (필수)
로컬에서:
```bash
claude setup-token        # Pro/Max 계정에서 실행, 출력 토큰 복사
```
> 이 세션에서 바로 뽑으려면 프롬프트에 `! claude setup-token` 입력.

GitHub → 레포 **Settings → Secrets and variables → Actions → New repository secret**:

| Secret 이름 | 값 | 비고 |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | `claude setup-token` 출력값 | **필수** |
| `NOTION_API_KEY` | (비워둠) | **선택** — 현재는 참조할 Notion 문서가 없어 **빈값**. 빈값이면 Notion 미참조 |

### 3) Notion 조건부 참조 (현재는 비활성)
- 워크플로는 **PR 본문에 `notion.so`/`notion.site` 링크가 있고 `NOTION_API_KEY`가 비어있지 않을 때만** Notion MCP를 설치·참조한다.
- 지금은 `NOTION_API_KEY`가 빈값이므로 Notion 관련 스텝은 전부 스킵된다.
- 나중에 Notion을 쓰려면: https://notion.so/my-integrations 에서 Integration(Read content) 생성 → 참조 페이지에 Connection 연결 → `NOTION_API_KEY` Secret 채우기.

---

## ⚠️ 첫 적용 시 정상 동작

- 이 워크플로를 **추가하는 PR에서는 실행되지 않는다.** GitHub 보안 정책상 워크플로 변경은 base 브랜치에 머지된 뒤에만 적용된다.
- 따라서: 이 PR을 **dev에 머지 → 이후 새 PR부터** Claude 리뷰가 작동한다.

## 트러블슈팅

- **리뷰가 안 돎**: ① `paths`(src/prisma/test)에 걸리는 변경인지 ② base가 dev/main인지 ③ PR이 draft 아닌지 ④ `CLAUDE_CODE_OAUTH_TOKEN` Secret 존재·철자 확인.
- **인증 오류**: `claude setup-token` 재발급 후 Secret 갱신.
- **사용량 한도**: 구독 사용량을 소모하므로, 트리거를 `synchronize`까지 늘리지 않고 `opened`/`ready_for_review`로 제한해 둠.

## 관련 파일
- `.github/workflows/claude-review.yml` — 이 워크플로
- `.github/workflows/codex-review.yml` — OpenAI 종량제판(비활성 보존)
- `CLAUDE.md` — 리뷰가 참조하는 프로젝트 규칙(보안·Swagger·컨벤션)
