import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AppException } from '../../common/errors/app-exception';
import { PropertyError } from '../property.errors';
import { Lease } from '../domain/lease.entity';
import { LEASE_REPOSITORY, LeaseRepository } from '../domain/lease.repository';
import { UNIT_REPOSITORY, UnitRepository } from '../domain/unit.repository';
import {
  BUILDING_REPOSITORY,
  BuildingRepository,
} from '../domain/building.repository';
import { EVENT_PUBLISHER, EventPublisher } from '../../events/event-publisher';
import { EventType, EntityType } from '../../events/event-type.enum';

export interface EndLeaseInput {
  userId: string;
  leaseId: string;
}

@Injectable()
export class EndLeaseUseCase {
  constructor(
    @Inject(LEASE_REPOSITORY) private readonly leases: LeaseRepository,
    @Inject(UNIT_REPOSITORY) private readonly units: UnitRepository,
    @Inject(BUILDING_REPOSITORY)
    private readonly buildings: BuildingRepository,
    @Inject(EVENT_PUBLISHER) private readonly events: EventPublisher,
  ) {}

  async execute(input: EndLeaseInput): Promise<Lease> {
    const lease = await this.leases.findById(input.leaseId);
    if (!lease) throw new AppException(PropertyError.LEASE_NOT_FOUND);

    // 권한: 계약 → 호실 → 건물 소유자가 요청자인지 확인(건물주만 입주 관리).
    const unit = await this.units.findById(lease.unitId);
    if (!unit) throw new AppException(PropertyError.UNIT_NOT_FOUND);
    const building = await this.buildings.findById(unit.buildingId);
    if (!building || !building.isOwnedBy(input.userId)) {
      throw new AppException(PropertyError.NOT_BUILDING_OWNER);
    }

    // 이미 종료된 계약이면 도메인 DomainError → 409로 변환.
    let ended: Lease;
    try {
      ended = lease.end();
    } catch {
      throw new AppException(PropertyError.LEASE_ALREADY_ENDED);
    }
    const saved = await this.leases.update(ended);

    await this.events.publish({
      eventId: randomUUID(),
      eventType: EventType.LeaseEnded,
      occurredAt: new Date().toISOString(),
      actorId: input.userId,
      entityType: EntityType.Lease,
      entityId: saved.id!,
      payload: { unitId: saved.unitId, endedAt: saved.endedAt?.toISOString() },
    });
    return saved;
  }
}
