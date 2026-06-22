# /me/leases 이름 보강 (백엔드) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox(`- [ ]`).

**Goal:** `GET /me/leases` 응답에 **건물 이름·호실 이름**을 포함해, 입주자가 자기 계약을 "○○ 건물 1503호"처럼 알아볼 수 있게 한다(FE-M1 대시보드 tenant 카드의 선행 보강).

**Architecture:** `ListMyLeasesUseCase`(application)가 `LeaseRepository.findByTenant`로 받은 각 Lease에 대해 `UnitRepository.findById`(이름·건물ID), `BuildingRepository.findById`(이름)를 조회해 뷰 모델로 합쳐 반환한다. 컨트롤러는 이름을 포함해 응답하고 Swagger에 응답 DTO를 노출한다. 기존 DDD 레이어/패턴 유지.

**Tech Stack:** NestJS 11 · Jest(`*.spec.ts` 단위 + `test/*.e2e-spec.ts`).

**근거:** FE-M1 대시보드 플랜 `2026-06-22-dashboard-home-frontend.md`의 "선행(선택)" 항목. 현재 응답은 `{id, unitId, status}`만이라 tenant가 호실을 식별 못 함.

## 비고(설계 판단)
- 입주자의 Lease는 보통 1~2건이라 lease당 unit/building 조회(N+1)는 허용 범위. 대량이 되면 배치 조회로 최적화(후속). 지금은 단순·명확 우선.
- 이름은 nullable(`unitName`/`buildingName`이 unit/building 삭제 등으로 없을 수 있음) → `string | null`로 두고 FE가 degrade.

---

## 파일 구조
- Modify `src/property/application/list-my-leases.use-case.ts` — 뷰 모델 반환(+repo 2개 주입)
- Test `src/property/application/list-my-leases.use-case.spec.ts` — 신규
- Create `src/property/interface/dto/lease-view.dto.ts` — 응답 DTO
- Modify `src/property/interface/property.controller.ts` — `me/leases` 응답에 이름 포함 + `@ApiResponse` type
- Test `test/property.e2e-spec.ts` — 이름 포함 검증

> 명령어: 단위 `npm test`, e2e `npm run test:e2e`(docker 필요), 린트 `npm run lint:check`.

---

## Task 1: 유스케이스 — 이름 포함 뷰 반환 (단위 TDD)

**Files:** Modify `src/property/application/list-my-leases.use-case.ts` · Test `src/property/application/list-my-leases.use-case.spec.ts`

- [ ] **Step 1: 실패 테스트 작성**

`src/property/application/list-my-leases.use-case.spec.ts` 신규:
```typescript
import { ListMyLeasesUseCase } from './list-my-leases.use-case';
import { Lease } from '../domain/lease.entity';
import { LeaseStatus } from '../domain/lease-status.enum';
import { Unit } from '../domain/unit.entity';
import { Building } from '../domain/building.entity';
import { LeaseRepository } from '../domain/lease.repository';
import { UnitRepository } from '../domain/unit.repository';
import { BuildingRepository } from '../domain/building.repository';

const LEASE = Lease.reconstitute({ id: 'l1', unitId: 'u1', tenantId: 't1', status: LeaseStatus.ACTIVE, endedAt: null });
const UNIT = Unit.reconstitute({ id: 'u1', buildingId: 'b1', name: '1503호', floor: 15 });
const BUILDING = Building.reconstitute({ id: 'b1', ownerId: 'o1', name: '래미안 역삼', address: '서울 강남구' });

const leaseRepo: Partial<LeaseRepository> = { findByTenant: () => Promise.resolve([LEASE]) };
const unitRepo: Partial<UnitRepository> = { findById: () => Promise.resolve(UNIT) };
const buildingRepo: Partial<BuildingRepository> = { findById: () => Promise.resolve(BUILDING) };

describe('ListMyLeasesUseCase', () => {
  it('각 Lease에 건물/호실 이름을 채워 반환', async () => {
    const useCase = new ListMyLeasesUseCase(
      leaseRepo as LeaseRepository, unitRepo as UnitRepository, buildingRepo as BuildingRepository);
    const result = await useCase.execute('t1');
    expect(result).toEqual([
      { id: 'l1', unitId: 'u1', unitName: '1503호', buildingName: '래미안 역삼', status: LeaseStatus.ACTIVE },
    ]);
  });

  it('호실/건물이 없으면 이름은 null', async () => {
    const useCase = new ListMyLeasesUseCase(
      leaseRepo as LeaseRepository,
      { findById: () => Promise.resolve(null) } as UnitRepository,
      buildingRepo as BuildingRepository);
    const [v] = await useCase.execute('t1');
    expect(v.unitName).toBeNull();
    expect(v.buildingName).toBeNull();
  });
});
```
> `Lease.reconstitute`/`Unit.reconstitute`/`Building.reconstitute`의 실제 인자 키를 해당 엔티티 파일에서 확인해 맞춘다.

Run: `npm test -- list-my-leases` → FAIL.

- [ ] **Step 2: 구현**

`src/property/application/list-my-leases.use-case.ts`:
```typescript
import { Inject, Injectable } from '@nestjs/common';
import { LeaseStatus } from '../domain/lease-status.enum';
import { LEASE_REPOSITORY, LeaseRepository } from '../domain/lease.repository';
import { UNIT_REPOSITORY, UnitRepository } from '../domain/unit.repository';
import { BUILDING_REPOSITORY, BuildingRepository } from '../domain/building.repository';

export interface LeaseView {
  id: string;
  unitId: string;
  unitName: string | null;
  buildingName: string | null;
  status: LeaseStatus;
}

@Injectable()
export class ListMyLeasesUseCase {
  constructor(
    @Inject(LEASE_REPOSITORY) private readonly leases: LeaseRepository,
    @Inject(UNIT_REPOSITORY) private readonly units: UnitRepository,
    @Inject(BUILDING_REPOSITORY) private readonly buildings: BuildingRepository,
  ) {}

  async execute(tenantId: string): Promise<LeaseView[]> {
    const leases = await this.leases.findByTenant(tenantId);
    return Promise.all(
      leases.map(async (l): Promise<LeaseView> => {
        const unit = await this.units.findById(l.unitId);
        const building = unit ? await this.buildings.findById(unit.buildingId) : null;
        return {
          id: l.id!,
          unitId: l.unitId,
          unitName: unit?.name ?? null,
          buildingName: building?.name ?? null,
          status: l.status,
        };
      }),
    );
  }
}
```
> `l.id`가 `string | null`이면 `l.id!`(findByTenant 결과는 영속된 엔티티라 id 보장).

Run: `npm test -- list-my-leases` → PASS.

- [ ] **Step 3: 커밋**
```bash
git add src/property/application/list-my-leases.use-case.ts src/property/application/list-my-leases.use-case.spec.ts
git commit -m "[M1]feat: /me/leases 유스케이스에 건물·호실 이름 포함"
```

---

## Task 2: 컨트롤러 응답 + DTO + Swagger

**Files:** Create `src/property/interface/dto/lease-view.dto.ts` · Modify `src/property/interface/property.controller.ts`

- [ ] **Step 1: 응답 DTO 생성**
`src/property/interface/dto/lease-view.dto.ts`:
```typescript
import { ApiProperty } from '@nestjs/swagger';
import { LeaseStatus } from '../../domain/lease-status.enum';

export class LeaseViewDto {
  @ApiProperty() id: string;
  @ApiProperty() unitId: string;
  @ApiProperty({ nullable: true, type: String }) unitName: string | null;
  @ApiProperty({ nullable: true, type: String }) buildingName: string | null;
  @ApiProperty({ enum: LeaseStatus, enumName: 'LeaseStatus' }) status: LeaseStatus;
}
```

- [ ] **Step 2: 컨트롤러 수정**
`property.controller.ts`의 `myLeasesHandler`:
```typescript
import { LeaseViewDto } from './dto/lease-view.dto';
```
```typescript
  @UseGuards(JwtAuthGuard)
  @Get('me/leases')
  @ApiOperation({ summary: '내 임대 목록 조회(건물·호실 이름 포함)' })
  @ApiResponse({ status: 200, type: [LeaseViewDto] })
  async myLeasesHandler(@CurrentUser() user: TokenPayload): Promise<LeaseViewDto[]> {
    return this.listMyLeases.execute(user.sub);
  }
```
> 기존 `leases.map((l) => ({ id, unitId, status }))` 매핑은 제거(유스케이스가 이미 뷰를 반환).

- [ ] **Step 3:** `npm run build` → 컴파일 확인. **커밋**
```bash
git add src/property/interface/dto/lease-view.dto.ts src/property/interface/property.controller.ts
git commit -m "[M1]feat: /me/leases 응답에 이름 포함 + LeaseViewDto Swagger 노출"
```

---

## Task 3: e2e — 이름 포함 검증

**Files:** Modify `test/property.e2e-spec.ts`

- [ ] **Step 1: 테스트 추가**
기존 흐름(OWNER 건물·호실 생성 → 초대코드 발급 → tenant redeem)을 재사용해, redeem 후 `GET /me/leases`가 이름을 포함하는지 검증:
```typescript
  it('GET /me/leases는 건물·호실 이름을 포함한다', async () => {
    // (선행) tenant가 어떤 호실에 입주(redeem)된 상태 — 기존 e2e 흐름/헬퍼 재사용
    const res = await request(app.getHttpServer() as App)
      .get('/me/leases')
      .set('Authorization', `Bearer ${tenantToken}`)
      .expect(200);
    const body = res.body as Array<{ unitName: string | null; buildingName: string | null; status: string }>;
    expect(body.length).toBeGreaterThan(0);
    expect(body[0].unitName).toBeTruthy();
    expect(body[0].buildingName).toBeTruthy();
  });
```
> `tenantToken`·생성한 건물/호실 이름은 기존 property e2e 셋업을 재사용한다.

- [ ] **Step 2:** `npm run test:e2e -- property` → PASS(docker 필요).
- [ ] **Step 3: 커밋**
```bash
git add test/property.e2e-spec.ts
git commit -m "[M1]test: /me/leases 이름 포함 e2e"
```

---

## Task 4: 마무리
- [ ] `npm run lint:check && npm test && npm run test:e2e` 통과.
- [ ] FE 연동: 보강 머지 후 FE-M1 `tenant-home.tsx`의 `호실 {l.unitId.slice(0,8)}` 표시를 `{l.buildingName} {l.unitName}`로 교체(별도 FE 변경).

## 성공 기준
- `GET /me/leases` → 각 항목에 `unitName`·`buildingName` 포함(없으면 null), `status` 유지.
- 단위/e2e 통과, Swagger에 `LeaseViewDto` 노출.
