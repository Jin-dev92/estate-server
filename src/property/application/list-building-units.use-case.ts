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
