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
