import { HttpException, HttpStatus } from '@nestjs/common';

// 카탈로그 항목 형태. 컨텍스트별 *.errors.ts가 이 모양의 const를 노출한다.
export interface AppErrorSpec {
  code: string;
  status: HttpStatus;
  message: string;
}

// 비즈니스 에러용 커스텀 예외. 카탈로그 스펙을 받아 던진다.
export class AppException extends HttpException {
  readonly code: string;

  constructor(spec: AppErrorSpec) {
    super(spec.message, spec.status);
    this.code = spec.code;
  }
}
