import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Lease } from '../domain/lease.entity';
import { LeaseStatus } from '../domain/lease-status.enum';
import { LeaseRepository } from '../domain/lease.repository';

@Injectable()
export class PrismaLeaseRepository implements LeaseRepository {
  constructor(private readonly prisma: PrismaService) {}

  // Prisma 행(endDate) ↔ 도메인(endedAt) 매핑 단일 출처.
  private toDomain(row: {
    id: string;
    unitId: string;
    tenantId: string;
    status: string;
    endDate: Date | null;
  }): Lease {
    return Lease.reconstitute({
      id: row.id,
      unitId: row.unitId,
      tenantId: row.tenantId,
      status: row.status as LeaseStatus,
      endedAt: row.endDate,
    });
  }

  async save(lease: Lease): Promise<Lease> {
    const row = await this.prisma.lease.create({
      data: {
        unitId: lease.unitId,
        tenantId: lease.tenantId,
        status: lease.status,
      },
    });
    return this.toDomain(row);
  }

  async findByTenant(tenantId: string): Promise<Lease[]> {
    const rows = await this.prisma.lease.findMany({ where: { tenantId } });
    return rows.map((row) => this.toDomain(row));
  }

  async findById(id: string): Promise<Lease | null> {
    const row = await this.prisma.lease.findUnique({ where: { id } });
    return row ? this.toDomain(row) : null;
  }

  async update(lease: Lease): Promise<Lease> {
    const row = await this.prisma.lease.update({
      where: { id: lease.id! },
      data: { status: lease.status, endDate: lease.endedAt },
    });
    return this.toDomain(row);
  }
}
