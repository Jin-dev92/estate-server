import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import * as Sentry from '@sentry/nestjs';
import { AppException } from './app-exception';
import { DomainError } from './domain-error';
import { ErrorResponse } from './error-response';
import { TokenPayload } from '../../auth/domain/token-issuer';
import { ConfigKey } from '../../config/config-keys';
import { shouldCapture4xx } from '../sentry/should-capture-4xx';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    const body = this.toErrorResponse(exception, req.url);
    if (body.statusCode >= 500) {
      this.logger.error(
        `${body.code} ${body.statusCode} ${req.url}`,
        exception instanceof Error ? exception.stack : undefined,
      );
      // 5xx(미처리/서버 오류)만 Sentry로. 4xx·도메인 예상 예외는 노이즈라 제외.
      Sentry.captureException(exception, (scope) => {
        this.applyContext(scope, req);
        return scope;
      });
    } else if (
      // 일부 4xx(422·400 검증 = FE/계약 버그 신호)는 낮은 샘플로만 캡처(기본 0=off).
      shouldCapture4xx(body.code, this.sample4xxRate())
    ) {
      Sentry.captureException(exception, (scope) => {
        scope.setLevel('warning'); // 5xx(error)와 구분
        scope.setTag('capture_reason', 'sampled_4xx');
        scope.setTag('code', body.code);
        this.applyContext(scope, req);
        return scope;
      });
    }
    res.status(body.statusCode).json(body);
  }

  // Sentry scope에 요청 컨텍스트(누가·어디로)를 싣는다. email은 PII라 제외.
  private applyContext(scope: Sentry.Scope, req: Request): void {
    const user = req.user as TokenPayload | undefined;
    if (user?.sub) scope.setUser({ id: user.sub });
    if (user?.role) scope.setTag('role', user.role);
    scope.setTag('path', req.url);
    scope.setTag('method', req.method);
  }

  // 4xx 샘플 캡처 비율(env). 기본 0 = 끔. 배포 직후·디버깅 때만 올린다.
  private sample4xxRate(): number {
    return Number(process.env[ConfigKey.Sentry4xxSampleRate]) || 0;
  }

  private toErrorResponse(exception: unknown, path: string): ErrorResponse {
    const timestamp = new Date().toISOString();

    if (exception instanceof AppException) {
      return {
        statusCode: exception.getStatus(),
        code: exception.code,
        message: exception.message,
        path,
        timestamp,
      };
    }
    if (exception instanceof DomainError) {
      return {
        statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
        code: exception.code,
        message: exception.message,
        path,
        timestamp,
      };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return {
        statusCode: status,
        code: this.deriveCode(status),
        message: this.extractMessage(exception),
        path,
        timestamp,
      };
    }
    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'COMMON_INTERNAL_ERROR',
      message: '서버 오류가 발생했습니다.',
      path,
      timestamp,
    };
  }

  // 잘 알려진 HTTP status → 공통 코드 매핑. status를 enum과 직접 비교(===)하면
  // no-unsafe-enum-comparison이 걸리므로, enum을 계산된 키로 쓰는 룩업 맵으로 처리한다.
  private static readonly STATUS_CODE_MAP: Record<number, string> = {
    [HttpStatus.BAD_REQUEST]: 'COMMON_VALIDATION_FAILED',
    [HttpStatus.UNAUTHORIZED]: 'COMMON_UNAUTHORIZED',
  };

  private deriveCode(status: number): string {
    return AllExceptionsFilter.STATUS_CODE_MAP[status] ?? `HTTP_${status}`;
  }

  private extractMessage(exception: HttpException): string {
    const response = exception.getResponse();
    if (typeof response === 'string') return response;
    const message = (response as { message?: string | string[] }).message;
    // ValidationPipe는 message를 배열로 준다. 빈 배열이면 message[0]이 undefined가
    // 되어 string 계약이 깨지므로, 원본 예외 메시지로 폴백한다.
    if (Array.isArray(message)) return message[0] ?? exception.message;
    return message ?? exception.message;
  }
}
