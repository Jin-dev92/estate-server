# README 와우포인트 설계 (채용 관점 개선 ①/⑤)

- 작성일: 2026-07-04
- 배경: 채용 인사담당자/면접관 관점 개선 로드맵 5건 중 1번째(순서: README 서사 → 성능 개선 스토리 → 분산 트레이싱 → 라이브 데모 → Testcontainers). README는 채용 담당자가 코드보다 먼저(그리고 대개 유일하게) 보는 화면인데, 현재 아키텍처 다이어그램(§4)이 114줄 아래에 묻혀 있고 "훑는 사람"용 요약 레이어가 없다.

## 1. 목표

첫 스크롤 안에서 이 프로젝트의 차별점이 전달되게 한다: **번호 없는 "한눈에 보기" 섹션**을 제목·소개 직후에 신설하고, 증명 포인트 4줄 + Mermaid 아키텍처 다이어그램 + 30초 요약 문단을 배치한다.

## 2. 변경 내용

### 2.1 신설 — "한눈에 보기" (기존 §1 앞)
- **이 프로젝트가 증명하는 것 (4줄, 숫자 포함)**:
  1. 이벤트 유실 없는 설계 — Transactional Outbox + DLQ(지수 백오프)
  2. 진짜 팬아웃 — Kafka 컨슈머 워커 3종, 독립 프로세스·독립 consumer group
  3. 측정 기반 개선 — k6 baseline/stress/spike, 병목(DB 풀)을 p95 13.6ms→1,734ms 통제 실험으로 특정
  4. 품질 게이트 — 단위테스트 225개 + CI(경고 0 lint·Prisma drift·자동 리뷰 게이트)
- **Mermaid 다이어그램 1장** (GitHub 네이티브 렌더링): 이벤트 흐름 중심.
  - 발행 경로 2종을 정확히 구분: **board·membership = Outbox 적재(단일 트랜잭션) → outbox-relay 폴링 → Kafka** / **chat = main producer 직접 발행(after-commit)** + Redis pub/sub 실시간 전달.
  - 소비: Kafka → 워커 3종(각자 consumer group) → PG(Message/Notification/AuditLog), notification-worker는 Redis pub/sub로 main WS에 역브리지.
  - Redis 캐시·rate limit은 main 부속으로 간단 표기.
  - 기존 ASCII에 없던 Outbox·relay 경로 보강(현 다이어그램의 누락).
- **30초 요약 문단**: 기존 §4 하단 불릿 2개(실시간/영속 분리, M5 워커 분리)를 흡수.

### 2.2 삭제·번호 당김
- 기존 §4 "아키텍처 한눈에"(ASCII) 삭제 — 다이어그램은 하나만 유지.
- §5→§4, §6→§5, §7→§6, §8→§7, §9→§8 번호 당김. 내부 앵커 링크는 없음을 확인(당김 안전).

## 3. 검증

- GitHub Mermaid 렌더링 확인(문법 오류 시 코드블록으로 노출되므로 PR diff/프리뷰에서 확인).
- 본문에서 옛 섹션 번호를 참조하는 문구가 남지 않았는지 grep.
- 서사의 숫자(테스트 225개, p95 수치)가 현재 사실과 일치하는지 확인 완료(2026-07-04 기준 `npm test` 225 passed).

## 4. 범위 밖

- 성능 before/after 수치 추가는 다음 작업(성능 개선 스토리)에서 "측정 기반 개선" 줄에 덧붙인다.
- README 이외 문서(docs/study 등) 변경 없음.
