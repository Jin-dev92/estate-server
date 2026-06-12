import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { MembershipChecker } from '../application/membership';

@Injectable()
export class PrismaMembershipChecker implements MembershipChecker {
  constructor(private readonly prisma: PrismaService) {}

  async isMember(userId: string, buildingId: string): Promise<boolean> {
    const owned = await this.prisma.building.findFirst({
      where: { id: buildingId, ownerId: userId },
      select: { id: true },
    });
    if (owned) return true;

    const lease = await this.prisma.lease.findFirst({
      where: {
        tenantId: userId,
        status: 'ACTIVE',
        unit: { buildingId },
      },
      select: { id: true },
    });
    return lease !== null;
  }
}
