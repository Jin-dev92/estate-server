import { CreateUnitUseCase } from './create-unit.use-case';
import { Building } from '../domain/building.entity';
import { Unit } from '../domain/unit.entity';
import { BuildingRepository } from '../domain/building.repository';
import { UnitRepository } from '../domain/unit.repository';

const OWNER_ID = 'owner1';
const BUILDING_ID = 'b1';

function buildingRepoWith(building: Building | null): BuildingRepository {
  return {
    save: (b) => Promise.resolve(b),
    findById: (id) => Promise.resolve(id === BUILDING_ID ? building : null),
    findByOwner: () => Promise.resolve([]),
  };
}

const unitRepo: UnitRepository = {
  save: (u) =>
    Promise.resolve(
      Unit.reconstitute({
        id: 'unit-generated',
        buildingId: u.buildingId,
        name: u.name,
        floor: u.floor,
      }),
    ),
  findById: () => Promise.resolve(null),
  findByBuilding: () => Promise.resolve([]),
};

const ownedBuilding = Building.reconstitute({
  id: BUILDING_ID,
  ownerId: OWNER_ID,
  name: '래미안',
  address: '주소',
});

describe('CreateUnitUseCase', () => {
  it('건물 소유자가 호실을 만들면 저장된다', async () => {
    const useCase = new CreateUnitUseCase(
      buildingRepoWith(ownedBuilding),
      unitRepo,
    );

    const unit = await useCase.execute({
      ownerId: OWNER_ID,
      buildingId: BUILDING_ID,
      name: '101호',
      floor: 1,
    });

    expect(unit.id).toBe('unit-generated');
    expect(unit.buildingId).toBe(BUILDING_ID);
  });

  it('소유자가 아니면 ForbiddenException', async () => {
    const useCase = new CreateUnitUseCase(
      buildingRepoWith(ownedBuilding),
      unitRepo,
    );

    await expect(
      useCase.execute({
        ownerId: 'someone-else',
        buildingId: BUILDING_ID,
        name: '101호',
        floor: 1,
      }),
    ).rejects.toMatchObject({ code: 'PROPERTY_NOT_BUILDING_OWNER' });
  });

  it('건물이 없으면 NotFoundException', async () => {
    const useCase = new CreateUnitUseCase(buildingRepoWith(null), unitRepo);

    await expect(
      useCase.execute({
        ownerId: OWNER_ID,
        buildingId: BUILDING_ID,
        name: '101호',
        floor: 1,
      }),
    ).rejects.toMatchObject({ code: 'PROPERTY_BUILDING_NOT_FOUND' });
  });
});
