import { ListMyLeasesUseCase } from './list-my-leases.use-case';
import { Lease } from '../domain/lease.entity';
import { LeaseStatus } from '../domain/lease-status.enum';
import { Unit } from '../domain/unit.entity';
import { Building } from '../domain/building.entity';
import { LeaseRepository } from '../domain/lease.repository';
import { UnitRepository } from '../domain/unit.repository';
import { BuildingRepository } from '../domain/building.repository';

const LEASE = Lease.reconstitute({
  id: 'l1',
  unitId: 'u1',
  tenantId: 't1',
  status: LeaseStatus.ACTIVE,
  endedAt: null,
});
const UNIT = Unit.reconstitute({ id: 'u1', buildingId: 'b1', name: '1503호', floor: 15 });
const BUILDING = Building.reconstitute({
  id: 'b1',
  ownerId: 'o1',
  name: '래미안 역삼',
  address: '서울 강남구',
});

const leaseRepo: Partial<LeaseRepository> = {
  findByTenant: () => Promise.resolve([LEASE]),
};
const unitRepo: Partial<UnitRepository> = {
  findById: () => Promise.resolve(UNIT),
};
const buildingRepo: Partial<BuildingRepository> = {
  findById: () => Promise.resolve(BUILDING),
};

describe('ListMyLeasesUseCase', () => {
  it('각 Lease에 건물/호실 이름과 buildingId를 채워 반환', async () => {
    const useCase = new ListMyLeasesUseCase(
      leaseRepo as LeaseRepository,
      unitRepo as UnitRepository,
      buildingRepo as BuildingRepository,
    );
    const result = await useCase.execute('t1');
    expect(result).toEqual([
      {
        id: 'l1',
        unitId: 'u1',
        unitName: '1503호',
        buildingName: '래미안 역삼',
        buildingId: 'b1',
        status: LeaseStatus.ACTIVE,
      },
    ]);
  });

  it('호실/건물이 없으면 이름과 buildingId는 null', async () => {
    const useCase = new ListMyLeasesUseCase(
      leaseRepo as LeaseRepository,
      { findById: () => Promise.resolve(null) } as unknown as UnitRepository,
      buildingRepo as BuildingRepository,
    );
    const [v] = await useCase.execute('t1');
    expect(v.unitName).toBeNull();
    expect(v.buildingName).toBeNull();
    expect(v.buildingId).toBeNull();
  });
});
