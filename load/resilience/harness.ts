/* eslint-disable no-console */
// ============================================================================
// M12 회복탄력성 파라미터 튜닝 하네스 (경량 실측 — Docker 불필요)
// ----------------------------------------------------------------------------
// 왜 k6가 아니라 이 하네스인가:
//   회복탄력성 계층은 "카카오가 오작동할 때만" 작동한다. 실제 카카오로는
//   1회용 인가코드·외부 rate limit 때문에 부하를 줄 수 없고, 장애를 주입할 수도 없다.
//   그래서 실제 프로덕션 경로(KakaoOAuthClient.exchangeAndFetch = 정책 조립 + 503 매핑)를
//   그대로 구동하되, 테스트와 동일하게 global.fetch에 "가짜 카카오"(지연·에러 주입)를
//   물려 카카오 장애 분포를 흉내낸다. 앱·DB·Redis·Kafka 없이 튜닝 대상만 정밀 측정한다.
//
// 실행: npx ts-node load/resilience/harness.ts
//   환경변수: HARNESS_CONCURRENCY(기본 20), HARNESS_DURATION_MS(셀당, 기본 2500),
//            HARNESS_THINK_MS(로그인 간 대기, 기본 120)
//
// think time이 중요한 이유(측정 함정): 회로가 열리면 이후 로그인은 즉시 503(≈0ms)이다.
// think time 없이 닫힌 루프로 돌리면 이 즉시-503을 초당 수만 건 회전시켜 p95=0·throughput
// 수만 같은 무의미한 수를 만든다. 실제 사용자는 로그인 1번 후 다음 시도까지 텀이 있으므로,
// 로그인 사이에 think time을 둬 페이싱한다(M8 부하테스트의 think time과 같은 원리).
// ============================================================================
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { ConfigKey } from '../../src/config/config-keys';
import { KakaoResilience } from '../../src/auth/infrastructure/kakao-resilience';
import { KakaoOAuthClient } from '../../src/auth/infrastructure/kakao-oauth.client';
import { AppException } from '../../src/common/errors/app-exception';

const CONCURRENCY = Number(process.env.HARNESS_CONCURRENCY) || 20;
const DURATION_MS = Number(process.env.HARNESS_DURATION_MS) || 2500;
const THINK_MS = Number(process.env.HARNESS_THINK_MS) || 120;

// ---- 가짜 카카오(fault injection) -----------------------------------------
interface Health {
  name: string;
  // 호출 1건의 지연(ms). 분포를 흉내내려고 매 호출 랜덤.
  latencyMs: () => number;
  // null=정상, 숫자=HTTP non-ok status, 'network'=fetch TypeError.
  failure: () => number | 'network' | null;
}

function uniform(min: number, max: number): () => number {
  return () => min + Math.random() * (max - min);
}
function rate(p: number, status: number): () => number | null {
  return () => (Math.random() < p ? status : null);
}

// global.fetch를 가짜 카카오로 교체. AbortSignal(타임아웃 정책)을 존중해
// 취소되면 즉시 reject → 백그라운드 타이머가 쌓이지 않게 한다.
function installFetch(h: Health): void {
  (globalThis as unknown as { fetch: unknown }).fetch = (
    url: string,
    init?: { signal?: AbortSignal },
  ): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const signal = init?.signal;
      const timer = setTimeout(() => {
        const f = h.failure();
        if (f === 'network') {
          reject(new TypeError('network error'));
          return;
        }
        const ok = f === null;
        const status = ok ? 200 : f;
        const body = url.includes('oauth/token')
          ? { access_token: 'AT' }
          : { id: 1, kakao_account: {} };
        resolve({ ok, status, json: () => Promise.resolve(body) });
      }, h.latencyMs());
      if (signal) {
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        });
      }
    });
}

function stubConfig(overrides: Record<string, string>): ConfigService {
  return {
    getOrThrow: (key: ConfigKey) =>
      key === ConfigKey.KakaoClientId ? 'cid' : 'csecret',
    get: (key: string) => overrides[key],
  } as unknown as ConfigService;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

interface CellResult {
  total: number;
  success: number;
  unavailable: number; // 503 AUTH_KAKAO_UNAVAILABLE
  clientErr: number; // 4xx 등 그 외
  p95All: number; // 전체 로그인 p95(ms)
  p95Ok: number; // 성공 로그인만 p95(ms) — 들어간 사용자 체감
  avg503: number; // 503 평균 지연(ms) — 낮을수록 fail-fast
  opens: number; // 서킷 open 횟수
}

// 파라미터 셋으로 클라이언트를 만들어, 가짜 카카오 상대로 동시성 부하를 준다.
async function runCell(
  params: Record<string, string>,
  h: Health,
  concurrency: number,
): Promise<CellResult> {
  installFetch(h);

  // 서킷 상태 로그를 카운트하며 콘솔 소음은 억제(원상 복구는 finally).
  let opens = 0;
  const origWarn = Logger.prototype.warn;
  const origLog = Logger.prototype.log;
  Logger.prototype.warn = function (msg?: unknown): void {
    if (typeof msg === 'string' && msg.includes('circuit OPEN')) opens += 1;
  } as typeof origWarn;
  Logger.prototype.log = function (): void {} as typeof origLog;

  try {
    const config = stubConfig(params);
    const client = new KakaoOAuthClient(config, new KakaoResilience(config));

    const allLat: number[] = [];
    const okLat: number[] = [];
    const lat503: number[] = [];
    const outcome = { success: 0, unavailable: 0, clientErr: 0 };
    const deadline = performance.now() + DURATION_MS;

    const worker = async (): Promise<void> => {
      while (performance.now() < deadline) {
        const t0 = performance.now();
        try {
          await client.exchangeAndFetch('code', 'cb');
          outcome.success += 1;
          okLat.push(performance.now() - t0);
        } catch (err) {
          if (
            err instanceof AppException &&
            err.code === 'AUTH_KAKAO_UNAVAILABLE'
          ) {
            outcome.unavailable += 1;
            lat503.push(performance.now() - t0);
          } else {
            outcome.clientErr += 1;
          }
        }
        allLat.push(performance.now() - t0);
        // think time: 실제 사용자 페이싱. 즉시-503 무한 회전을 막는다.
        await sleep(THINK_MS);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    allLat.sort((a, b) => a - b);
    okLat.sort((a, b) => a - b);
    const avg503 =
      lat503.length === 0
        ? 0
        : lat503.reduce((a, b) => a + b, 0) / lat503.length;
    return {
      total: allLat.length,
      success: outcome.success,
      unavailable: outcome.unavailable,
      clientErr: outcome.clientErr,
      p95All: percentile(allLat, 95),
      p95Ok: percentile(okLat, 95),
      avg503,
      opens,
    };
  } finally {
    Logger.prototype.warn = origWarn;
    Logger.prototype.log = origLog;
  }
}

// ---- 시나리오 × 파라미터 매트릭스 -----------------------------------------
interface Variant {
  label: string;
  params: Record<string, string>;
  concurrency?: number;
}
interface Scenario {
  health: Health;
  note: string;
  variants: Variant[];
}

const DEFAULT: Record<string, string> = {}; // env 미설정 → 코드 기본값(3000/3/5/10000/10/20)

const scenarios: Scenario[] = [
  {
    health: { name: '정상', latencyMs: uniform(60, 140), failure: () => null },
    note: '카카오 정상(지연 60~140ms, 에러 0%) — 오버헤드·오탐 확인',
    variants: [{ label: 'default', params: DEFAULT }],
  },
  {
    health: {
      name: '느림',
      latencyMs: uniform(500, 3500),
      failure: () => null,
    },
    note: '카카오 지연(500~3500ms, 일부 타임아웃 초과) — 타임아웃 값 트레이드오프',
    variants: [
      { label: 'timeout 3000(default)', params: DEFAULT },
      { label: 'timeout 1500', params: { KAKAO_TIMEOUT_MS: '1500' } },
    ],
  },
  {
    health: {
      name: '간헐에러',
      latencyMs: uniform(60, 140),
      failure: rate(0.3, 503),
    },
    note: '카카오 30% 5xx — 브레이커가 지나치게 빨리 열리나(임계×재시도 배수)',
    variants: [
      { label: 'threshold 5·retry 3(default)', params: DEFAULT },
      { label: 'threshold 8', params: { KAKAO_BREAKER_THRESHOLD: '8' } },
      { label: 'retry 1', params: { KAKAO_RETRY_MAX_ATTEMPTS: '1' } },
    ],
  },
  {
    health: { name: '장애', latencyMs: uniform(60, 140), failure: () => 503 },
    note: '카카오 100% 5xx — fail-fast(회로 open 후 즉시 503) 확인',
    variants: [
      { label: 'threshold 5(default)', params: DEFAULT },
      { label: 'threshold 2', params: { KAKAO_BREAKER_THRESHOLD: '2' } },
    ],
  },
  {
    health: {
      name: '느림+고동시성',
      latencyMs: uniform(800, 1500),
      failure: () => null,
    },
    note: '지연 + 동시 40(벌크헤드 10+20 초과) — 벌크헤드 거절 vs 확대',
    variants: [
      { label: 'bulkhead 10/20(default)', params: DEFAULT, concurrency: 40 },
      {
        label: 'bulkhead 30/40',
        params: { KAKAO_BULKHEAD_CONCURRENT: '30', KAKAO_BULKHEAD_QUEUE: '40' },
        concurrency: 40,
      },
    ],
  },
];

function pct(part: number, total: number): string {
  return total === 0 ? '0%' : `${((part / total) * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  console.log(
    `\n# M12 회복탄력성 파라미터 실측 (concurrency=${CONCURRENCY}, duration=${DURATION_MS}ms/cell, think=${THINK_MS}ms)\n`,
  );
  console.log(
    '- p95(all): 전체 로그인 / p95(ok): 성공만(들어간 사용자 체감) / 503평균: 낮을수록 fail-fast\n',
  );
  for (const s of scenarios) {
    console.log(`\n## 시나리오: ${s.health.name} — ${s.note}\n`);
    console.log(
      '| 변형 | 총 | 성공 | 503 | p95(all)ms | p95(ok)ms | 503평균ms | 서킷open |',
    );
    console.log('|---|---|---|---|---|---|---|---|');
    for (const v of s.variants) {
      const r = await runCell(v.params, s.health, v.concurrency ?? CONCURRENCY);
      console.log(
        `| ${v.label} | ${r.total} | ${pct(r.success, r.total)} | ${pct(
          r.unavailable,
          r.total,
        )} | ${r.p95All.toFixed(0)} | ${r.p95Ok.toFixed(0)} | ${r.avg503.toFixed(
          0,
        )} | ${r.opens} |`,
      );
    }
  }
  console.log('\n(끝)\n');
}

void main();
