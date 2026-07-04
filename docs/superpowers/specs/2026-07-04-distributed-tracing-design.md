# M10.5 — 분산 트레이싱(프로세스 경계 trace 컨텍스트 전파) 설계

- 작성일: 2026-07-04
- 대상 레포: `estate-server`
- 선행: M10(`docs/superpowers/specs/2026-06-17-m10-sentry-design.md`, Sentry 연동), Outbox(`docs/superpowers/specs/2026-06-16-outbox-design.md`)

## 0. 용어

이 문서에서 반복되는 용어를 먼저 정의합니다.

- **trace(트레이스)**: 하나의 요청이 여러 함수·프로세스를 거치는 전체 경로를 한 묶음으로 본 것. 고유한 `trace_id`로 식별됩니다.
- **span(스팬)**: trace 안의 개별 작업 구간(예: "HTTP 요청 처리", "Kafka 발행", "알림 저장"). span은 부모-자식 관계를 가지며, 자식 span은 부모의 `trace_id`를 공유합니다.
- **trace 컨텍스트 전파(context propagation)**: 한 프로세스의 trace 정보를 다른 프로세스로 넘겨, 양쪽 작업이 같은 trace에 속하게 잇는 것. 표준은 W3C Trace Context이며 `traceparent`라는 문자열 헤더로 `trace_id`와 부모 span 정보를 실어 나릅니다.
- **Outbox**: 도메인 변경과 "이벤트를 발행하겠다"는 기록을 같은 DB 트랜잭션으로 저장해 두고, 별도 프로세스(relay)가 나중에 그 기록을 읽어 Kafka로 발행하는 패턴. 발행이 지연된다는 점이 트레이싱에서 중요합니다.

## 1. 배경 / 문제

현재 각 프로세스(main, outbox-relay, 워커 3종)에는 M10에서 Sentry가 개별 초기화되어 있습니다. Sentry는 HTTP 요청마다 trace를 자동 생성하지만, **그 trace는 프로세스 경계에서 끊깁니다.** 즉 `POST /posts/:id/likes` 한 번을 추적하면 다음 세 개가 서로 무관한 trace로 남습니다.

1. main의 HTTP 요청 처리
2. outbox-relay의 Kafka 발행
3. notification-worker의 알림 생성

결과적으로 "이 좋아요 클릭이 이 알림을 만들었다"는 인과를 하나의 흐름으로 확인할 수 없습니다. M10.5의 목표는 **프로세스 경계를 넘어 trace 컨텍스트를 전파**하여, 위 세 구간을 하나의 연결된 trace로 만드는 것입니다.

**이번 범위**: 프로세스 경계 전파에 한정합니다. 프로세스 내부의 DB·Redis 구간 계측은 Sentry 자동 계측에 맡기고, 이 작업에서 커스텀 span을 별도로 추가하지 않습니다.

## 2. 설계 결정

- **트레이싱 기술**: 기존 `@sentry/nestjs`(v10, 내부적으로 OpenTelemetry 기반)를 확장합니다. 새 트레이싱 스택을 도입하지 않습니다.
- **전파 캐리어**: Kafka 메시지 헤더. 표준 W3C `traceparent` 계열 헤더를 메시지에 실어 나릅니다. 도메인 이벤트 봉투(payload)에 관측 정보를 섞지 않기 위해 헤더를 씁니다.
- **비침습 원칙**: 트레이싱은 관측 부가기능이므로, 실패하거나 비활성(Sentry DSN 미설정)이어도 이벤트 발행·소비 흐름을 절대 막지 않습니다.

## 3. 전파 흐름

발행 경로가 두 가지이므로 나누어 설명합니다. 두 경로 모두 최종적으로 **워커가 Kafka 헤더에서 컨텍스트를 추출해 trace를 이어받는** 것으로 수렴합니다.

```
[origin = main HTTP 요청 → Sentry가 root trace 생성]
        │
        ├─ (A) 직접 발행: chat-events (KafkaEventPublisher.publish, 커밋 후)
        │        요청 컨텍스트가 아직 살아있음 → 지금 trace 헤더 캡처 → Kafka 헤더에 실음
        │
        └─ (B) Outbox 발행: board·membership-events                 ← 지연 발행이라 핵심
                 outbox.add 시점(= 요청 컨텍스트)에 trace 헤더 캡처
                        → OutboxEvent 행에 저장
                 ── 요청 종료, 시간 경과 ──
                 outbox-relay(별도 프로세스): 저장된 헤더를 읽어 Kafka 헤더에 실어 발행

[consumer = 워커 3종(@EventPattern)]
        Kafka 헤더에서 컨텍스트 추출 → Sentry.continueTrace로 핸들러를 자식 span으로 실행
```

경로 B가 핵심인 이유: trace를 만든 HTTP 요청은 relay가 발행할 때쯤 이미 종료되어 컨텍스트가 사라집니다. 따라서 컨텍스트를 **캡처 시점(outbox.add)에 DB에 저장**했다가 relay가 되살려야 합니다.

## 4. 컴포넌트

### 4.1 트레이싱 헬퍼 (`src/common/tracing/`, 신규)

Sentry의 컨텍스트 주입/추출 API를 한 파일에 캡슐화합니다. Sentry API가 바뀌어도 이 파일만 고치면 되도록 경계를 좁힙니다.

- `captureTraceHeaders(): Record<string, string>` — 현재 활성 trace를 표준 헤더 맵으로 직렬화합니다(주입, inject). 활성 trace가 없거나 Sentry 비활성이면 빈 맵을 반환합니다.
- `continueTraceFromHeaders(headers, fn)` — 헤더 맵에서 컨텍스트를 복원(추출, extract)하고, `fn`을 그 trace의 자식으로 실행합니다. 헤더가 없으면 `fn`을 그대로 실행합니다(새 trace로 폴백).

### 4.2 발행 측

- **직접 발행(경로 A)**: `KafkaEventPublisher.publish`가 `captureTraceHeaders()`로 헤더를 얻어, `ClientKafka.emit`의 메시지 `headers`에 실어 발행합니다.
- **Outbox 캡처(경로 B)**: `PrismaOutboxStore.add`가 `captureTraceHeaders()`로 주변 컨텍스트를 캡처해 새 컬럼에 저장합니다. **use-case는 수정하지 않습니다** — store가 주변 trace를 투명하게 캡처하므로 호출부는 트레이싱을 몰라도 됩니다.
- **Outbox 발행(경로 B)**: `RelayOutboxUseCase`가 저장된 헤더를 읽어 발행에 전달합니다. `KafkaEventPublisher.publishOrThrow`가 그 헤더를 Kafka 메시지 헤더로 설정합니다. relay의 발행 구간도 `continueTraceFromHeaders`로 감싸, Outbox로 인한 지연이 trace상 하나의 span으로 보이게 합니다.

### 4.3 소비 측

- 워커 컨트롤러 3종(`NotificationWorkerController`, `AuditWorkerController`, `ChatPersistenceController`)이 `@Ctx() KafkaContext`로 원본 Kafka 메시지 헤더에 접근합니다. 헤더에서 컨텍스트를 추출해 `continueTraceFromHeaders`로 핸들러 본문을 감쌉니다. 이로써 워커의 처리가 원본 trace의 자식 span이 됩니다.

## 5. 스키마 변경

`OutboxEvent`에 nullable 컬럼 **`traceContext Json?`** 를 추가합니다.

- 저장 내용: `captureTraceHeaders()`가 만든 헤더 맵(예: `{ "traceparent": "...", ... }`).
- nullable인 이유: 트레이싱 비활성(DSN 없음)이거나 캡처가 실패한 경우 `null`이며, 마이그레이션 이전의 기존 행도 `null`로 안전합니다.
- 읽기 경로: `fetchPending` 원시 SQL의 `SELECT` 목록과 `OutboxRow`/`OutboxRecord` 타입에 `traceContext`를 추가하여 relay가 값을 받도록 합니다.

## 6. 에러 처리 (비침습)

트레이싱 관련 코드는 전부 실패를 흡수합니다.

- 캡처(`captureTraceHeaders`) 실패 → 빈 맵 반환, 발행 계속.
- 추출/이어받기(`continueTraceFromHeaders`) 실패 또는 헤더 부재 → `fn`을 그대로 실행(기존처럼 워커가 자체 trace 시작).
- Sentry DSN 미설정 → 헬퍼가 no-op, 파이프라인 영향 없음.
- 구버전 메시지(헤더 없음)·마이그레이션 이전 Outbox 행(`traceContext` null) → 폴백 경로로 정상 처리.

## 7. 테스트

- **헬퍼 단위 테스트**: `captureTraceHeaders`가 활성 컨텍스트에서 헤더를 만들고, `continueTraceFromHeaders`가 헤더로 `fn`을 실행하며, 헤더 부재 시에도 `fn`을 실행하는지 검증합니다.
- **배선(plumbing) 검증**: 실제 Sentry trace 연결이 아니라 **헤더가 경로를 타고 흐르는지**를 검증합니다.
  - `PrismaOutboxStore.add`가 캡처한 헤더를 `traceContext` 컬럼에 저장.
  - relay가 그 값을 발행에 전달, `KafkaEventPublisher`가 Kafka 메시지 `headers`에 설정.
  - 워커 컨트롤러가 `KafkaContext` 헤더에서 컨텍스트를 추출해 `continueTraceFromHeaders`를 호출.
- **폴백**: 헤더가 없을 때 크래시 없이 핸들러가 실행되는지.

## 8. 구현 시 확정할 사항 (플랜에서 문서 기반으로 결정)

- **Sentry v10의 정확한 주입/추출 API와 헤더 이름**: Sentry는 자체 `sentry-trace`+`baggage` 헤더를, OpenTelemetry는 W3C `traceparent`+`tracestate`를 씁니다. `@sentry/nestjs` v10에서 어느 API로 inject/extract하는지, 어떤 헤더 키가 나오는지를 Sentry 공식 문서로 확정합니다. 설계는 "헤더로 전파"에 고정하고, 정확한 키·함수는 구현 단계에서 결정합니다.
- **`ClientKafka.emit`의 헤더 전달 형식**: `@nestjs/microservices` v11의 Kafka 메시지에 `headers`를 싣는 정확한 형태를 문서로 확인합니다.

## 9. 검증 기준

- 단위 테스트 전부 통과, `build`·`lint:check` 통과.
- 헤더가 발행→저장→재발행→소비 경로를 타고 흐르는 것이 테스트로 확인됨.
- 트레이싱 미설정·헤더 부재 시에도 이벤트 파이프라인이 정상 동작(회귀 없음).
- (수동 데모) Sentry DSN을 설정한 상태에서 좋아요 클릭 1건이 `HTTP → Outbox → relay 발행 → 워커 알림 생성`으로 하나의 trace에 연결되어 보이는지 확인. 이 시각화는 Sentry 프로젝트가 있어야 가능합니다(코드는 DSN 없이도 안전하게 no-op).

## 10. 범위 밖

- 프로세스 내부 DB·Redis 구간의 커스텀 span 추가(Sentry 자동 계측에 위임).
- 별도 OpenTelemetry Collector·Jaeger 등 외부 트레이싱 백엔드 구축.
- 샘플링 정책 변경(M10의 `tracesSampler`를 그대로 사용).
