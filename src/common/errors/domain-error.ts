// 도메인 레이어 불변식 위반. 프레임워크 의존이 없어 도메인 엔티티가 직접 import한다.
// (이 파일은 NestJS/외부 프레임워크를 import하지 않는다.)
export class DomainError extends Error {
  readonly code: string;

  constructor(message: string, code = 'VALIDATION_FAILED') {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}
