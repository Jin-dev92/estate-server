import { Inject, Injectable } from '@nestjs/common';
import { Lease } from '../domain/lease.entity';
import { LEASE_REPOSITORY, LeaseRepository } from '../domain/lease.repository';

@Injectable()
export class ListMyLeasesUseCase {
  constructor(
    @Inject(LEASE_REPOSITORY) private readonly leases: LeaseRepository,
  ) {}

  execute(tenantId: string): Promise<Lease[]> {
    return this.leases.findByTenant(tenantId);
  }
}
