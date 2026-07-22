# M14 Task 8 통제 실험 결과

이 문서는 RED 지표와 이벤트 적체 지표가 실제 부하 및 장애 조건을 어떻게 관측하는지 검증한 결과입니다. RED는 요청률(Rate), 오류율(Errors), 처리 시간(Duration)을 함께 보는 서비스 관측 방식입니다. 모든 수치는 2026-07-22 로컬 개발 환경에서 측정한 실제 관측값입니다.

## 환경

| 항목 | 관측값 |
|---|---|
| 실험 일자 | 2026-07-22 (Asia/Seoul) |
| Node | v24.16.0 |
| pnpm | 9.15.0 |
| k6 | v1.7.1 |
| Docker | 29.4.0 |
| 애플리케이션 | 호스트의 `node dist/main`, 포트 `3000` |
| 워커 | `node dist/workers/*` 기반 outbox-relay, persistence, audit, notification 4종 |
| Prometheus | `prom/prometheus`, 포트 `9090`, scrape 주기 15초 |
| Grafana | `grafana/grafana`, 포트 `3001` |
| PostgreSQL | `postgres:16-alpine`, 포트 `5433` |
| Redis | `redis:7-alpine`, 포트 `6379` |
| Kafka | `confluentinc/cp-kafka:7.7.1`, KRaft 단일 노드, 포트 `9092` |

Prometheus는 `host.docker.internal:3000`의 `estate-server` target을 수집했습니다. 실험 전 상태는 다음 PromQL로 확인했으며, 관측값은 `1`이었습니다. `up`은 Prometheus가 해당 target을 정상적으로 수집할 수 있는지를 나타내는 지표입니다.

```promql
up{job="estate-server"}
```

## RED 기준선

### 읽기 경로 교차 검증

k6는 가상 사용자를 생성해 HTTP 부하를 주는 도구입니다. 읽기 기준선은 `read-posts`를 30초 동안 20 VU까지 증가시키고, 1분 동안 20 VU를 유지한 뒤, 10초 동안 0 VU로 낮추는 `PROFILE=load` 조건에서 측정했습니다. VU는 동시에 동작하는 가상 사용자입니다.

| 지표 | k6 | Prometheus | 비교 |
|---|---:|---:|---|
| 요청 수 | 1,592건, 15.76/s | GET `/buildings/:buildingId/posts` 약 1,700건 | 방향성 일치 |
| 오류 | `http_req_failed` 0.00% (0/1,592), checks 100% (1,592/1,592) | 5xx 오류율 0 | 일치 |
| p95 | 26.09ms | 24.06ms (`0.02406s`) | 동일 자릿수이며 근접 |
| 평균·중앙값·최댓값 | avg 13.73ms, med 12.31ms, max 112.26ms | 해당 비교값 없음 | k6 관측값만 기록 |

p95는 요청의 95%가 해당 시간 안에 끝났음을 뜻하는 백분위 지연 시간입니다. Prometheus 요청 수는 히스토그램 윈도우와 extrapolation 차이 때문에 k6와 정확히 같지 않지만, 약 1,700건과 1,592건으로 방향성이 일치했습니다. `/metrics` 요청은 `route="/metrics"`로 별도 노출되므로 애플리케이션 경로 비교에서 제외했습니다. 이는 metric route의 라벨 카디널리티가 통제되고 있음을 함께 보여줍니다.

교차 검증에 사용한 쿼리는 다음과 같습니다.

```promql
sum(increase(http_requests_total{route="/buildings/:buildingId/posts",method="GET"}[5m]))

sum(rate(http_requests_total{route!="/metrics",status=~"5.."}[5m]))
/
clamp_min(sum(rate(http_requests_total{route!="/metrics"}[5m])), 1)

histogram_quantile(
  0.95,
  sum by (le) (
    rate(http_request_duration_seconds_bucket{route="/buildings/:buildingId/posts",method="GET"}[5m])
  )
)
```

### 쓰기 경로에서 확인된 구조적 한계

동일 사용자인 `load-owner`를 20 VU로 사용한 `create-post` 부하에서는 `http_reqs`가 1,609건이었고, 성공한 check는 3.85%인 62/1,609건이었습니다. `http_req_failed`는 96.14%였습니다. `RATE_LIMIT_USER_MAX=60/60s` 제한으로 대부분의 요청이 HTTP 429로 거절되었습니다.

Prometheus에는 POST `/buildings/:buildingId/posts`의 HTTP 201 응답이 약 22건 기록됐지만, 429 응답은 `http_requests_total`에 한 건도 기록되지 않았습니다. 5xx 오류율은 0이었습니다.

원인은 NestJS 요청 실행 순서가 Guard → Interceptor이기 때문입니다. Guard는 핸들러 진입 전에 인증이나 요청 제한을 판단하는 계층이며, Interceptor는 핸들러 전후의 처리를 감싸는 계층입니다. rate-limit Guard가 429를 반환하면 요청은 `HttpMetricsInterceptor.intercept()`에 도달하지 않습니다. 따라서 Interceptor 기반 RED는 핸들러 파이프라인에 진입한 요청만 집계하며, 429 rate-limit과 401/403 인증·인가 거절은 누락됩니다. 이는 관측 결과가 아니라 계측 위치에서 비롯되는 구조적 한계입니다.

## Outbox PENDING 통제 실험

Outbox는 데이터베이스 변경과 후속 이벤트 발행을 연결하기 위해 이벤트를 먼저 테이블에 저장하는 방식입니다. `PENDING`은 아직 relay가 전달하지 않은 정상 대기 상태를 뜻합니다.

통제 실험은 다음 순서로 진행했습니다.

1. relay 실행 상태에서 `outbox_events_pending=0`, `outbox_events_failed=0`을 기준선으로 확인했습니다.
2. outbox-relay만 정지했습니다.
3. `create-post` 부하로 62건의 성공 요청을 만들었습니다.
4. `outbox_events_pending`의 피크가 60까지 증가했고, `outbox_events_failed`는 0을 유지했습니다.
5. relay를 재시작하자 약 7초 안에 pending이 0으로 드레인됐습니다. 드레인은 쌓인 대기 항목이 소비되어 0으로 감소하는 과정입니다.

relay는 `OUTBOX_POLL_MS=1000` 간격으로 polling하고 batch 단위로 처리했습니다. 이 구간의 애플리케이션 예외와 Sentry 이벤트는 모두 0이었습니다. create 요청은 HTTP 201로 성공했고, PENDING은 예외가 아니라 relay 정지로 생긴 정상 대기 행이기 때문입니다.

```promql
outbox_events_pending
outbox_events_failed
```

## Kafka lag 통제 실험

Kafka consumer lag은 consumer group이 아직 처리하지 못한 메시지 수입니다.

### 라이브 측정에서 발견된 critical 결함

통제 실험에 앞서 `kafka_consumer_lag` collector가 존재하지 않는 consumer group을 조회하는 결함이 발견됐습니다. NestJS `ServerKafka`는 설정한 `groupId` 뒤에 `-server` postfix를 붙입니다. 따라서 실제 브로커 group은 `persistence-worker-server`였지만, collector는 base명인 `persistence-worker`로 `fetchOffsets`를 호출했습니다.

검증 과정과 근거는 다음과 같습니다.

1. `kafka-consumer-groups --list`에는 `persistence-worker-server`만 존재했습니다.
2. `persistence-worker` 조회 결과는 `does not exist`였습니다.
3. 존재하지 않는 group에는 committed offset이 없으므로 collector는 latest offset을 lag으로 오측했습니다.
4. 수정 전 `membership-events` partition 1의 lag이 latest offset과 같은 10으로 나타난 사례가 확인됐습니다.
5. 기존 unit test는 `fetchOffsets`가 전달받은 동일 `groupId`를 그대로 mock했기 때문에 postfix 불일치를 잡지 못했습니다.

commit `ce0b194`에서 collector가 ConsumerGroup 상수에 `-server` postfix를 붙여 실제 group명으로 조회하고 라벨링하도록 수정했습니다. 또한 `fetchOffsets` 호출의 `groupId`를 검증하는 회귀 방지 test가 추가됐습니다. 수정 후 정상 소비 상태의 lag은 0으로 측정됐습니다. 이 결함은 mock 기반 test가 아니라 실제 브로커를 사용한 라이브 측정에서 확인됐습니다.

### 수정 후 통제 실험

메시지는 Socket.IO login → 방 보장 → join → `message` emit → `MessageSent` → outbox → relay → `chat-events` topic → worker 소비 순서로 전달됐습니다. 동일 방의 메시지는 동일 partition key를 사용했습니다.

1. relay, audit worker, notification worker는 계속 실행한 채 persistence worker만 정지했습니다.
2. 유효한 chat 메시지 50건을 전송했습니다.
3. 다음 시계열에서 피크 lag 50을 관측했습니다.

```promql
kafka_consumer_lag{
  group="persistence-worker-server",
  topic="chat-events",
  partition="2"
}
```

4. 동일 방의 메시지가 같은 partition key를 사용했으므로 partition 2에 lag 50이 집중됐습니다.
5. 실행 중이던 `audit-worker-server`와 `notification-worker-server`의 `chat-events` lag은 각각 0을 유지했습니다.
6. persistence worker를 재시작하자 약 3초 안에 lag이 0으로 드레인됐습니다.

이 구간의 애플리케이션 예외와 Sentry 이벤트는 모두 0이었습니다. 메시지는 유효했으며, 정지한 consumer만 메시지를 소비하지 않은 무예외 적체였습니다.

## Sentry와 metrics 비교

Sentry는 개별 예외와 stack trace를 수집해 실패의 근본 원인을 추적하는 도구입니다. metrics는 여러 요청이나 메시지의 상태를 숫자로 집계하고 시간에 따른 변화를 관측하는 데이터입니다.

| 비교 항목 | Sentry | metrics |
|---|---|---|
| 주 관측 대상 | 개별 예외, stack trace, 근본 원인 | 집계된 backlog, 시간 추세, drain 과정 |
| relay 정지 | 애플리케이션 예외가 없어 이벤트 0 | `outbox_events_pending` 피크 60과 약 7초 내 drain 포착 |
| persistence consumer 정지 | 애플리케이션 예외가 없어 이벤트 0 | `kafka_consumer_lag` 피크 50과 약 3초 내 drain 포착 |
| 적합한 진단 | 예외가 발생한 요청이나 handler 실패 분석 | 예외 없이 처리량이 멈추거나 backlog가 누적되는 상태 분석 |

두 통제 적체는 모두 Sentry 이벤트를 0건 생성했지만, metrics는 적체의 증가와 해소를 모두 포착했습니다. 실험 중 main 로그에 기록된 ERROR 3건은 의도적인 worker 정지·재시작에 따른 KafkaJS consumer rebalance heartbeat 알림이었습니다. handler 예외, 5xx, outbox failed가 아니므로 정상적인 재조정 과정에서 발생한 양성 로그입니다.

## 한계와 결론

이번 측정에는 다음 한계가 있습니다.

1. Interceptor 기반 RED는 Guard가 거절한 429/401/403 요청을 집계하지 못합니다. 비즈니스 handler에 도달한 트래픽은 관측하지만, 전체 요청률을 얻으려면 Guard 계층의 별도 계측이 필요합니다.
2. on-scrape collector는 scrape마다 outbox `groupBy` DB query와 Kafka `fetchOffsets` query를 실행합니다. 1,000ms timeout과 실패 시 sample 생략으로 보호하지만, scrape 빈도를 높일 때는 DB와 Kafka 부하를 고려해야 합니다.
3. `kafka_consumer_lag`는 NestJS `ServerKafka`의 `-server` postfix에 결합되어 있습니다. worker의 `postfixId`가 바뀌면 collector 상수도 함께 갱신해야 합니다.
4. Kafka는 KRaft 단일 노드이며 전체 실험은 로컬 개발 규모에서 수행됐습니다. 프로덕션의 partition 수, 복제 구성, 부하와 다르므로 절대 성능 수치로 일반화할 수 없습니다.
5. `/metrics`에는 인증이 없습니다. 운영 환경에서는 네트워크 수준의 접근 제한이 필요합니다.

읽기 경로에서 k6와 Prometheus는 요청 수의 방향, 오류 0, p95 26.09ms와 24.06ms를 교차 검증했습니다. 반면 쓰기 경로에서는 Guard가 거절한 요청이 RED에서 누락되는 계측 범위를 확인했습니다. Outbox PENDING 60과 Kafka lag 50은 예외 없이 생성된 적체였으며, metrics는 각각 약 7초와 약 3초의 drain까지 관측했습니다. 따라서 Sentry와 metrics는 대체 관계가 아닙니다. Sentry는 개별 실패의 원인 분석에, metrics는 집계된 시스템 상태와 조용한 적체의 감지에 각각 필요합니다.
