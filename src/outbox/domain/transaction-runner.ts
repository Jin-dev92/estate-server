import { Prisma } from '@prisma/client';

// 트랜잭션 범위 Prisma 클라이언트(모델 delegate + $queryRaw 사용 가능).
export type TransactionClient = Prisma.TransactionClient;

export const TRANSACTION_RUNNER = Symbol('TRANSACTION_RUNNER');

// 콜백을 하나의 DB 트랜잭션으로 실행한다. 콜백이 throw하면 전체 롤백.
export interface TransactionRunner {
  run<T>(fn: (tx: TransactionClient) => Promise<T>): Promise<T>;
}
