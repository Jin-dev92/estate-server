import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { AppException } from './app-exception';
import { DomainError } from './domain-error';
import { ErrorResponse } from './error-response';

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
    }
    res.status(body.statusCode).json(body);
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
    if (Array.isArray(message)) return message[0];
    return message ?? exception.message;
  }
}
