import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Unit } from '../domain/unit.entity';
import {
  BUILDING_REPOSITORY,
  BuildingRepository,
} from '../domain/building.repository';
import { UNIT_REPOSITORY, UnitRepository } from '../domain/unit.repository';

export interface CreateUnitInput {
  ownerId: string;
  buildingId: string;
  name: string;
  floor: number;
}

@Injectable()
export class CreateUnitUseCase {
  constructor(
    @Inject(BUILDING_REPOSITORY) private readonly buildings: BuildingRepository,
    @Inject(UNIT_REPOSITORY) private readonly units: UnitRepository,
  ) {}

  async execute(input: CreateUnitInput): Promise<Unit> {
    const building = await this.buildings.findById(input.buildingId);
    if (!building) throw new NotFoundException('building not found');
    if (!building.isOwnedBy(input.ownerId)) {
      throw new ForbiddenException('not the building owner');
    }
    const unit = Unit.create({
      buildingId: input.buildingId,
      name: input.name,
      floor: input.floor,
    });
    return this.units.save(unit);
  }
}
