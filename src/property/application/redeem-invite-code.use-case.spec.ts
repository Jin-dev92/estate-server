import { NotFoundException } from '@nestjs/common';
import { RedeemInviteCodeUseCase } from './redeem-invite-code.use-case';
import { Lease } from '../domain/lease.entity';
import { LeaseStatus } from '../domain/lease-status.enum';
import { LeaseRepository } from '../domain/lease.repository';
import {
  InviteCodePayload,
  InviteCodeStore,
  IssuedInvite,
} from '../domain/invite-code.store';

const TENANT_ID = 'tenant1';
const UNIT_ID = 'unit1';

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
    });
    return Promise.resolve(this.saved);
  }
  findByTenant(): Promise<Lease[]> {
    return Promise.resolve([]);
  }
}

describe('RedeemInviteCodeUseCase', () => {
  it('유효한 코드면 입주자를 호실에 연결하는 Lease(ACTIVE)를 만든다', async () => {
    const leaseRepo = new CapturingLeaseRepo();
    const useCase = new RedeemInviteCodeUseCase(new FakeInviteStore(), leaseRepo);

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
    );

    await expect(
      useCase.execute({ tenantId: TENANT_ID, code: 'EXPIRED' }),
    ).rejects.toThrow(NotFoundException);
  });
});
