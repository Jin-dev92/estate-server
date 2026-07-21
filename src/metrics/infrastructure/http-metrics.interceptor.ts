import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { Request, Response } from 'express';
import { Counter, Histogram, Registry } from 'prom-client';
import { defer, Observable } from 'rxjs';
import { finalize } from 'rxjs/operators';
import { METRICS_REGISTRY } from './metrics.registry';

// RED(Rate/Errors/Duration) 메트릭 이름·라벨. 매직 스트링 반복을 막기 위해
// 상수로 추출한다.
const HTTP_REQUESTS_TOTAL_METRIC = 'http_requests_total';
const HTTP_REQUEST_DURATION_SECONDS_METRIC = 'http_request_duration_seconds';
const HTTP_METRIC_LABEL_NAMES = ['method', 'route', 'status'] as const;

// 초 단위 히스토그램 버킷. 5ms~5s 구간을 커버해 대부분의 API 응답 시간
// 분포를 촘촘하게 관찰할 수 있게 한다.
const HTTP_REQUEST_DURATION_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5,
];

// 라우트 패턴을 찾지 못했을 때(핸들러/컨트롤러 경로 메타데이터가 비어있을 때)의
// 기본값. 루트("/") 요청을 뜻한다.
const ROOT_ROUTE = '/';

const NANOSECONDS_PER_SECOND = 1e9;

// HTTP 요청마다 RED(Rate/Errors/Duration) 메트릭을 기록하는 전역 인터셉터.
// 라벨은 반드시 "라우트 패턴"(예: /buildings/:buildingId/posts)을 써야 한다.
// 원시 URL이나 파라미터 값(building-1 등)을 라벨로 쓰면 Prometheus 라벨
// 카디널리티가 사용자 수만큼 폭발하므로 절대 사용하지 않는다.
@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor {
  private readonly requestsTotal: Counter<
    (typeof HTTP_METRIC_LABEL_NAMES)[number]
  >;
  private readonly requestDurationSeconds: Histogram<
    (typeof HTTP_METRIC_LABEL_NAMES)[number]
  >;

  constructor(
    @Inject(METRICS_REGISTRY) registry: Registry,
    private readonly reflector: Reflector,
  ) {
    // 메트릭은 인터셉터 인스턴스당 한 번만 생성한다(요청마다 생성하면
    // prom-client가 "metric already registered" 에러를 던진다).
    this.requestsTotal = new Counter({
      name: HTTP_REQUESTS_TOTAL_METRIC,
      help: 'HTTP 요청 총 횟수 (method/route/status 라벨)',
      labelNames: HTTP_METRIC_LABEL_NAMES,
      registers: [registry],
    });
    this.requestDurationSeconds = new Histogram({
      name: HTTP_REQUEST_DURATION_SECONDS_METRIC,
      help: 'HTTP 요청 처리 시간(초) 분포',
      labelNames: HTTP_METRIC_LABEL_NAMES,
      buckets: HTTP_REQUEST_DURATION_BUCKETS,
      registers: [registry],
    });
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const route = this.resolveRoute(context);
    const httpContext = context.switchToHttp();
    const request = httpContext.getRequest<Request>();
    const response = httpContext.getResponse<Response>();

    // defer로 감싸 구독(=요청 처리 시작) 시점에 타이머를 시작한다.
    // 인터셉터 생성 시점이 아니라 매 요청마다 새로 측정해야 한다.
    return defer(() => {
      const startedAt = process.hrtime.bigint();

      return next.handle().pipe(
        // finalize는 성공/에러/취소 모든 경로에서 실행되므로, 에러 응답도
        // 빠짐없이 Rate/Errors 카운트에 반영된다.
        finalize(() => {
          const elapsedSeconds =
            Number(process.hrtime.bigint() - startedAt) /
            NANOSECONDS_PER_SECOND;
          const labels = {
            method: request.method,
            route,
            status: String(response.statusCode),
          };

          this.requestsTotal.inc(labels);
          this.requestDurationSeconds.observe(labels, elapsedSeconds);
        }),
      );
    });
  }

  // 컨트롤러(@Controller) + 핸들러(@Get 등) 경로 메타데이터를 합쳐 라우트
  // 패턴 문자열을 만든다. request.url/originalUrl은 실제 파라미터 값을
  // 담고 있어 절대 쓰지 않는다.
  private resolveRoute(context: ExecutionContext): string {
    const controllerPath =
      this.reflector.get<string>(PATH_METADATA, context.getClass()) ?? '';
    const handlerPath =
      this.reflector.get<string>(PATH_METADATA, context.getHandler()) ?? '';

    const segments = [controllerPath, handlerPath]
      .flatMap((segment) => segment.split('/'))
      .filter((segment) => segment.length > 0);

    return segments.length > 0 ? `/${segments.join('/')}` : ROOT_ROUTE;
  }
}
