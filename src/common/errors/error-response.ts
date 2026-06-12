// 에러 응답 봉투(4xx/5xx 전용). FE는 이 구조를 계약으로 받는다.
export interface ErrorResponse {
  statusCode: number;
  code: string;
  message: string;
  path: string;
  timestamp: string;
}
