# FE-M2 선행: 호실 목록 조회 (백엔드) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development 또는 executing-plans. 체크박스(`- [ ]`) 사용.

**Goal:** OWNER가 건물의 호실 목록을 조회하는 `GET /buildings/:buildingId/units`를 추가한다(FE-M2 건물 관리의 필수 선행 — 현재 호실은 POST만 있고 목록 조회가 없음).

**Architecture:** 기존 DDD 패턴. `UnitRepository`에 `findByBuilding`을 더하고, 소유권을 검증하는 `ListBuildingUnitsUseCase`(application)를 만든다. 컨트롤러에 OWNER 가드 GET 라우트 + 응답 DTO를 추가한다.

**Tech Stack:** NestJS 11 · Prisma · Jest(단위 `*.spec.ts` + `test/*.e2e-spec.ts`).

**근거:** README §7 Property에 GET units 부재. `UnitRepository`는 `save`/`findById`만 보유.

---

## 파일 구조
- Modify `src/property/domain/unit.repository.ts` — `findByBuilding` 추가
- Modify `src/property/infrastructure/prisma-unit.repository.ts` — 구현
- Create `src/property/application/list-building-units.use-case.ts` — 소유권 검증 + 목록
- Test `src/property/application/list-building-units.use-case.spec.ts`
- Create `src/property/interface/dto/unit-view.dto.ts`
- Modify `src/property/property.module.ts` — provider 등록
- Modify `src/property/interface/property.controller.ts` — GET 라우트
- Test `test/property.e2e-spec.ts`

> 명령어: 단위 `npm test`, e2e `npm run test:e2e`(docker), 린트 `npm run lint:check`.

---

## Task 1: 리포지토리 — findByBuilding

**Files:** Modify `unit.repository.ts`, `prisma-unit.repository.ts`

- [ ] **Step 1:** 인터페이스에 추가 — `unit.repository.ts`:
```typescript
export interface UnitRepository {
  save(unit: Unit): Promise<Unit>;
  findById(id: string): Promise<Unit | null>;
  findByBuilding(buildingId: string): Promise<Unit[]>;
}
```
- [ ] **Step 2:** Prisma 구현 — `prisma-unit.repository.ts`에 추가(기존 `findById` 매핑 패턴을 따라 `this.prisma.unit.findMany({ where: { buildingId } })` → 도메인 엔티티 매핑). 기존 파일의 reconstitute/매핑 방식을 그대로 사용한다.
- [ ] **Step 3:** `npm test -- property` → 기존 테스트 통과(컴파일·인터페이스 정합). 필요 시 spec의 fake UnitRepository에 `findByBuilding(){ return Promise.resolve([]); }` 추가.
- [ ] **Step 4: 커밋** `[M1]feat: UnitRepository.findByBuilding 추가`

---

## Task 2: ListBuildingUnitsUseCase (단위 TDD)

**Files:** Create `list-building-units.use-case.ts` + spec

- [ ] **Step 1: 실패 테스트** — `list-building-units.use-case.spec.ts`:
```typescript
import { ListBuildingUnitsUseCase } from './list-building-units.use-case';
import { Unit } from '../domain/unit.entity';
import { Building } from '../domain/building.entity';
import { UnitRepository } from '../domain/unit.repository';
import { BuildingRepository } from '../domain/building.repository';

const BUILDING = Building.reconstitute({ id: 'b1', ownerId: 'o1', name: '래미안', address: '서울' });
const UNITS = [Unit.reconstitute({ id: 'u1', buildingId: 'b1', name: '101호', floor: 1 })];
const buildings: Partial<BuildingRepository> = { findById: () => Promise.resolve(BUILDING) };
const units: Partial<UnitRepository> = { findByBuilding: () => Promise.resolve(UNITS) };

describe('ListBuildingUnitsUseCase', () => {
  it('소유 건물의 호실 목록을 반환', async () => {
    const uc = new ListBuildingUnitsUseCase(buildings as BuildingRepository, units as UnitRepository);
    const r = await uc.execute({ ownerId: 'o1', buildingId: 'b1' });
    expect(r).toEqual([{ id: 'u1', buildingId: 'b1', name: '101호', floor: 1 }]);
  });
  it('소유자가 아니면 NOT_BUILDING_OWNER', async () => {
    const uc = new ListBuildingUnitsUseCase(buildings as BuildingRepository, units as UnitRepository);
    await expect(uc.execute({ ownerId: 'other', buildingId: 'b1' }))
      .rejects.toMatchObject({ code: 'PROPERTY_NOT_BUILDING_OWNER' });
  });
});
```
> `building.isOwnedBy(ownerId)`는 기존 엔티티에 있음(issue-invite 유스케이스가 사용). `reconstitute` 인자 키는 실제 엔티티로 확인.

- [ ] **Step 2:** `npm test -- list-building-units` → FAIL.
- [ ] **Step 3: 구현** — `list-building-units.use-case.ts`:
```typescript
import { Inject, Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app-exception';
import { PropertyError } from '../property.errors';
import { BUILDING_REPOSITORY, BuildingRepository } from '../domain/building.repository';
import { UNIT_REPOSITORY, UnitRepository } from '../domain/unit.repository';

export interface ListBuildingUnitsInput { ownerId: string; buildingId: string; }
export interface UnitView { id: string; buildingId: string; name: string; floor: number; }

@Injectable()
export class ListBuildingUnitsUseCase {
  constructor(
    @Inject(BUILDING_REPOSITORY) private readonly buildings: BuildingRepository,
    @Inject(UNIT_REPOSITORY) private readonly units: UnitRepository,
  ) {}
  async execute(input: ListBuildingUnitsInput): Promise<UnitView[]> {
    const building = await this.buildings.findById(input.buildingId);
    if (!building) throw new AppException(PropertyError.BUILDING_NOT_FOUND);
    if (!building.isOwnedBy(input.ownerId)) throw new AppException(PropertyError.NOT_BUILDING_OWNER);
    const units = await this.units.findByBuilding(input.buildingId);
    return units.map((u) => ({ id: u.id!, buildingId: u.buildingId, name: u.name, floor: u.floor }));
  }
}
```
> `PropertyError.BUILDING_NOT_FOUND`/`NOT_BUILDING_OWNER` 코드는 property.errors.ts에 존재(없으면 기존 코드명 확인해 맞춤).
- [ ] **Step 4:** `npm test -- list-building-units` → PASS.
- [ ] **Step 5: 커밋** `[M1]feat: 건물 호실 목록 유스케이스(소유권 검증)`

---

## Task 3: 엔드포인트 + DTO + 모듈

**Files:** Create `unit-view.dto.ts`, Modify `property.module.ts`, `property.controller.ts`

- [ ] **Step 1: DTO** — `src/property/interface/dto/unit-view.dto.ts`:
```typescript
import { ApiProperty } from '@nestjs/swagger';
export class UnitViewDto {
  @ApiProperty() id: string;
  @ApiProperty() buildingId: string;
  @ApiProperty() name: string;
  @ApiProperty() floor: number;
}
```
- [ ] **Step 2: provider 등록** — `property.module.ts` providers 배열에 `ListBuildingUnitsUseCase` 추가(import 포함).
- [ ] **Step 3: 컨트롤러 라우트** — `property.controller.ts`에 주입(`private readonly listUnits: ListBuildingUnitsUseCase`) + 라우트:
```typescript
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.OWNER)
  @Get('buildings/:buildingId/units')
  @ApiParam({ name: 'buildingId', description: '호실을 조회할 건물 ID' })
  @ApiOperation({ summary: '건물 호실 목록 조회(OWNER, 건물 소유자)' })
  @ApiResponse({ status: 200, type: [UnitViewDto] })
  @ApiResponse({ status: 403, type: ErrorResponseDto, description: '건물 소유자 아님' })
  @ApiResponse({ status: 404, type: ErrorResponseDto, description: '건물 없음' })
  listUnitsHandler(@CurrentUser() user: TokenPayload, @Param('buildingId') buildingId: string): Promise<UnitViewDto[]> {
    return this.listUnits.execute({ ownerId: user.sub, buildingId });
  }
```
- [ ] **Step 4:** `npm run build` → 컴파일. **커밋** `[M1]feat: GET /buildings/:id/units 엔드포인트`

---

## Task 4: e2e + 마무리
- [ ] `test/property.e2e-spec.ts`에 추가: OWNER가 건물·호실 생성 후 `GET /buildings/:id/units`가 그 호실을 포함(기존 셋업 재사용). 다른 OWNER로 조회 시 403.
- [ ] `npm run lint:check && npm test && npm run test:e2e` 통과.

## 성공 기준
- `GET /buildings/:buildingId/units` → 소유 건물의 호실 목록(id·buildingId·name·floor). 비소유자 403, 없는 건물 404. Swagger에 `UnitViewDto` 노출.
