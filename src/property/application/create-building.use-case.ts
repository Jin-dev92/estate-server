import { Inject, Injectable } from '@nestjs/common';
import { Building } from '../domain/building.entity';
import {
  BUILDING_REPOSITORY,
  BuildingRepository,
} from '../domain/building.repository';

export interface CreateBuildingInput {
  ownerId: string;
  name: string;
  address: string;
}

@Injectable()
export class CreateBuildingUseCase {
  constructor(
    @Inject(BUILDING_REPOSITORY) private readonly buildings: BuildingRepository,
  ) {}

  execute(input: CreateBuildingInput): Promise<Building> {
    const building = Building.create(input);
    return this.buildings.save(building);
  }
}
