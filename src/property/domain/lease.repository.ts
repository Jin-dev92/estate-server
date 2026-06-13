import { Lease } from './lease.entity';

export const LEASE_REPOSITORY = Symbol('LEASE_REPOSITORY');

export interface LeaseRepository {
  save(lease: Lease): Promise<Lease>;
  findByTenant(tenantId: string): Promise<Lease[]>;
  findById(id: string): Promise<Lease | null>;
  update(lease: Lease): Promise<Lease>;
}
