import { RedeemInviteCodeUseCase } from './redeem-invite-code.use-case';
import { Lease } from '../domain/lease.entity';
import { LeaseStatus } from '../domain/lease-status.enum';
import { LeaseRepository } from '../domain/lease.repository';
import {
  InviteCodePayload,
  InviteCodeStore,
  IssuedInvite,
} from '../domain/invite-code.store';
import { EventPublisher } from '../../events/event-publisher';
import { EventType, EntityType } from '../../events/event-type.enum';

const TENANT_ID = 'tenant1';
const UNIT_ID = 'unit1';
// Task 5: TenantJoined 이벤트 발행 테스트용 상수
const TENANT_ID_EVT = 't1';
const UNIT_ID_EVT = 'unit1';
const LEASE_ID_EVT = 'lease1';
const CODE_EVT = 'ABC123';
const ISSUED_BY = 'owner1';

class FakeInviteStore implements InviteCodeStore {
  issue(): Promise<IssuedInvite> {
    return Promise.resolve({ code: 'x', expiresInSec: 1 });
  }
  redeem(code: string): Promise<InviteCodePayload | null> {
    return Promise.resolve(
      code === 'GOOD' ? { unitId: UNIT_ID, issuedBy: 'owner1' } : null,
    );
  }
}

class CapturingLeaseRepo implements LeaseRepository {
  public saved: Lease | null = null;
  save(lease: Lease): Promise<Lease> {
    this.saved = Lease.reconstitute({
      id: 'lease-generated',
      unitId: lease.unitId,
      tenantId: lease.tenantId,
      status: lease.status,
      endedAt: null,
    });
    return Promise.resolve(this.saved);
  }
  findByTenant(): Promise<Lease[]> {
    return Promise.resolve([]);
  }
  findById(): Promise<Lease | null> {
    return Promise.resolve(null);
  }
  update(lease: Lease): Promise<Lease> {
    return Promise.resolve(lease);
  }
}

/** 이벤트를 발행하지 않는 no-op 퍼블리셔 (기존 테스트용) */
const noopEvents: EventPublisher = {
  publish: () => Promise.resolve(),
};

/** Task 5: EventPublisher mock 빌더 */
function makeEventDeps(redeemResult: InviteCodePayload | null) {
  const saved = Lease.reconstitute({
    id: LEASE_ID_EVT,
    unitId: UNIT_ID_EVT,
    tenantId: TENANT_ID_EVT,
    status: LeaseStatus.ACTIVE,
    endedAt: null,
  });

  const invites: Partial<InviteCodeStore> = {
    redeem: () => Promise.resolve(redeemResult),
  };

  const leases: Partial<LeaseRepository> = {
    save: () => Promise.resolve(saved),
  };

  const published: unknown[] = [];
  const events: EventPublisher = {
    publish: (e) => {
      published.push(e);
      return Promise.resolve();
    },
  };

  return { invites, leases, events, published };
}

describe('RedeemInviteCodeUseCase', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('유효한 코드면 입주자를 호실에 연결하는 Lease(ACTIVE)를 만든다', async () => {
    const leaseRepo = new CapturingLeaseRepo();
    const useCase = new RedeemInviteCodeUseCase(
      new FakeInviteStore(),
      leaseRepo,
      noopEvents,
    );

    const lease = await useCase.execute({ tenantId: TENANT_ID, code: 'GOOD' });

    expect(lease.id).toBe('lease-generated');
    expect(lease.unitId).toBe(UNIT_ID);
    expect(lease.tenantId).toBe(TENANT_ID);
    expect(lease.status).toBe(LeaseStatus.ACTIVE);
  });

  it('만료·사용·오타 코드(null)면 NotFoundException', async () => {
    const useCase = new RedeemInviteCodeUseCase(
      new FakeInviteStore(),
      new CapturingLeaseRepo(),
      noopEvents,
    );

    await expect(
      useCase.execute({ tenantId: TENANT_ID, code: 'EXPIRED' }),
    ).rejects.toMatchObject({ code: 'PROPERTY_INVALID_INVITE_CODE' });
  });

  // ── Task 5: TenantJoined 이벤트 발행 ────────────────────────────────────
  it('초대코드 사용 시 TenantJoined를 발행한다', async () => {
    // Arrange
    const { invites, leases, events, published } = makeEventDeps({
      unitId: UNIT_ID_EVT,
      issuedBy: ISSUED_BY,
    });
    const useCase = new RedeemInviteCodeUseCase(
      invites as InviteCodeStore,
      leases as LeaseRepository,
      events,
    );

    // Act
    await useCase.execute({ tenantId: TENANT_ID_EVT, code: CODE_EVT });

    // Assert
    expect(published).toEqual([
      expect.objectContaining({
        eventType: EventType.TenantJoined,
        entityType: EntityType.Lease,
        entityId: LEASE_ID_EVT,
        actorId: TENANT_ID_EVT,
        payload: expect.objectContaining({ unitId: UNIT_ID_EVT }),
      }),
    ]);
  });

  it('유효하지 않은 코드면 발행하지 않는다', async () => {
    // Arrange
    const { invites, leases, events, published } = makeEventDeps(null);
    const useCase = new RedeemInviteCodeUseCase(
      invites as InviteCodeStore,
      leases as LeaseRepository,
      events,
    );

    // Act & Assert
    await expect(
      useCase.execute({ tenantId: TENANT_ID_EVT, code: CODE_EVT }),
    ).rejects.toMatchObject({ code: 'PROPERTY_INVALID_INVITE_CODE' });
    expect(published).toEqual([]);
  });
});
