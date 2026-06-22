import { EndLeaseUseCase } from './end-lease.use-case';
import { Lease } from '../domain/lease.entity';
import { LeaseStatus } from '../domain/lease-status.enum';
import { Unit } from '../domain/unit.entity';
import { Building } from '../domain/building.entity';
import { LeaseRepository } from '../domain/lease.repository';
import { UnitRepository } from '../domain/unit.repository';
import { BuildingRepository } from '../domain/building.repository';
import {
  TransactionRunner,
  TransactionClient,
} from '../../outbox/domain/transaction-runner';
import { OutboxStore } from '../../outbox/domain/outbox-store';
import { EventType, EntityType } from '../../events/event-type.enum';

const OWNER_ID = 'owner1';
const TENANT_ID = 't1';
const LEASE_ID = 'lease1';
const UNIT_ID = 'unit1';
const BUILDING_ID = 'b1';

// 테스트용 더미 TransactionClient
const TX = {} as unknown as TransactionClient;

// txRunner: 콜백을 즉시 실행해 TX를 넘긴다
const txRunner: TransactionRunner = {
  run: (fn) => fn(TX),
};

function deps(opts: { lease?: Lease | null; ownerId?: string } = {}) {
  const lease =
    opts.lease === undefined
      ? Lease.reconstitute({
          id: LEASE_ID,
          unitId: UNIT_ID,
          tenantId: TENANT_ID,
          status: LeaseStatus.ACTIVE,
          endedAt: null,
        })
      : opts.lease;
  const unit = Unit.reconstitute({
    id: UNIT_ID,
    buildingId: BUILDING_ID,
    name: '101',
    floor: 1,
  });
  const building = Building.reconstitute({
    id: BUILDING_ID,
    ownerId: opts.ownerId ?? OWNER_ID,
    name: '빌딩',
    address: '주소',
  });

  const updated: Lease[] = [];
  let updateTx: TransactionClient | undefined;
  const leases: LeaseRepository = {
    save: (l) => Promise.resolve(l),
    findByTenant: () => Promise.resolve([]),
    findById: () => Promise.resolve(lease),
    update: (l, tx) => {
      updated.push(l);
      updateTx = tx;
      return Promise.resolve(l);
    },
  };
  const units: UnitRepository = {
    save: (u) => Promise.resolve(u),
    findById: () => Promise.resolve(unit),
    findByBuilding: () => Promise.resolve([]),
  };
  const buildings: Partial<BuildingRepository> = {
    findById: () => Promise.resolve(building),
  };

  const added: unknown[] = [];
  const outbox: OutboxStore = {
    add: (e) => {
      added.push(e);
      return Promise.resolve();
    },
    fetchPending: () => Promise.resolve([]),
    markPublished: () => Promise.resolve(),
    markFailed: () => Promise.resolve({ quarantined: false }),
  };

  return {
    leases,
    units,
    buildings,
    outbox,
    updated,
    added,
    getUpdateTx: () => updateTx,
  };
}

describe('EndLeaseUseCase', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('건물 OWNER가 종료하면 update 후 LeaseEnded를 outbox에 적재한다', async () => {
    const { leases, units, buildings, outbox, updated, added, getUpdateTx } =
      deps();
    const useCase = new EndLeaseUseCase(
      leases,
      units,
      buildings as BuildingRepository,
      txRunner,
      outbox,
    );

    await useCase.execute({ userId: OWNER_ID, leaseId: LEASE_ID });

    expect(updated[0].status).toBe(LeaseStatus.ENDED);
    expect(added).toEqual([
      expect.objectContaining({
        eventType: EventType.LeaseEnded,
        entityType: EntityType.Lease,
        entityId: LEASE_ID,
      }),
    ]);
    // leases.update가 TX를 받았는지 검증
    expect(getUpdateTx()).toBe(TX);
  });

  it('OWNER가 아니면 NOT_BUILDING_OWNER로 거부하고 적재하지 않는다', async () => {
    const { leases, units, buildings, outbox, added } = deps({
      ownerId: 'someone-else',
    });
    const useCase = new EndLeaseUseCase(
      leases,
      units,
      buildings as BuildingRepository,
      txRunner,
      outbox,
    );

    await expect(
      useCase.execute({ userId: OWNER_ID, leaseId: LEASE_ID }),
    ).rejects.toMatchObject({ code: 'PROPERTY_NOT_BUILDING_OWNER' });
    expect(added).toEqual([]);
  });

  it('없는 계약이면 LEASE_NOT_FOUND', async () => {
    const { leases, units, buildings, outbox } = deps({ lease: null });
    const useCase = new EndLeaseUseCase(
      leases,
      units,
      buildings as BuildingRepository,
      txRunner,
      outbox,
    );

    await expect(
      useCase.execute({ userId: OWNER_ID, leaseId: LEASE_ID }),
    ).rejects.toMatchObject({ code: 'PROPERTY_LEASE_NOT_FOUND' });
  });
});
