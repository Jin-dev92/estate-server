import { Inject, Injectable } from '@nestjs/common';
import { Building } from '../domain/building.entity';
import {
  BUILDING_REPOSITORY,
  BuildingRepository,
} from '../domain/building.repository';

@Injectable()
export class ListMyBuildingsUseCase {
  constructor(
    @Inject(BUILDING_REPOSITORY) private readonly buildings: BuildingRepository,
  ) {}

  execute(ownerId: string): Promise<Building[]> {
    return this.buildings.findByOwner(ownerId);
  }
}
