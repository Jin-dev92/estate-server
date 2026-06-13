import { Lease } from './lease.entity';
import { LeaseStatus } from './lease-status.enum';
import { DomainError } from '../../common/errors/domain-error';

function activeLease(): Lease {
  return Lease.reconstitute({
    id: 'lease1',
    unitId: 'unit1',
    tenantId: 't1',
    status: LeaseStatus.ACTIVE,
    endedAt: null,
  });
}

describe('Lease.end', () => {
  it('ACTIVE 계약을 종료하면 status=ENDED, endedAt이 채워진 새 인스턴스를 반환한다', () => {
    const lease = activeLease();

    const ended = lease.end();

    expect(ended.status).toBe(LeaseStatus.ENDED);
    expect(ended.endedAt).toBeInstanceOf(Date);
  });

  it('이미 종료된 계약을 다시 종료하면 DomainError', () => {
    const ended = activeLease().end();

    expect(() => ended.end()).toThrow(DomainError);
  });
});
