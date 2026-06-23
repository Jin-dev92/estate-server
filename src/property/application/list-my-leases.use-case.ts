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
  buildingId: string | null;
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
          buildingId: unit?.buildingId ?? null,
          status: l.status,
        };
      }),
    );
  }
}
