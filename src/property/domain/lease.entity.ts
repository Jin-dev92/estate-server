import { LeaseStatus } from './lease-status.enum';
import { DomainError } from '../../common/errors/domain-error';

interface LeaseProps {
  id: string | null;
  unitId: string;
  tenantId: string;
  status: LeaseStatus;
  endedAt: Date | null;
}

export class Lease {
  private constructor(private readonly props: LeaseProps) {}

  static create(input: { unitId: string; tenantId: string }): Lease {
    if (!input.unitId) throw new DomainError('호실 ID는 필수입니다.');
    if (!input.tenantId) throw new DomainError('입주자 ID는 필수입니다.');
    return new Lease({
      id: null,
      unitId: input.unitId,
      tenantId: input.tenantId,
      status: LeaseStatus.ACTIVE,
      endedAt: null,
    });
  }

  static reconstitute(props: LeaseProps): Lease {
    return new Lease(props);
  }

  // 계약 종료: 상태를 ENDED로, 종료 시각을 채운 새 인스턴스를 반환한다(불변 패턴).
  end(): Lease {
    if (this.props.status === LeaseStatus.ENDED) {
      throw new DomainError('이미 종료된 계약입니다.');
    }
    return new Lease({
      ...this.props,
      status: LeaseStatus.ENDED,
      endedAt: new Date(),
    });
  }

  get id(): string | null {
    return this.props.id;
  }
  get unitId(): string {
    return this.props.unitId;
  }
  get tenantId(): string {
    return this.props.tenantId;
  }
  get status(): LeaseStatus {
    return this.props.status;
  }
  get endedAt(): Date | null {
    return this.props.endedAt;
  }
}
