import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Lease } from '../domain/lease.entity';
import { LEASE_REPOSITORY, LeaseRepository } from '../domain/lease.repository';
import {
  INVITE_CODE_STORE,
  InviteCodeStore,
} from '../domain/invite-code.store';

export interface RedeemInviteCodeInput {
  tenantId: string;
  code: string;
}

@Injectable()
export class RedeemInviteCodeUseCase {
  constructor(
    @Inject(INVITE_CODE_STORE) private readonly invites: InviteCodeStore,
    @Inject(LEASE_REPOSITORY) private readonly leases: LeaseRepository,
  ) {}

  async execute(input: RedeemInviteCodeInput): Promise<Lease> {
    const payload = await this.invites.redeem(input.code);
    if (!payload) {
      // 만료/이미 사용/존재하지 않음을 구분하지 않는다(코드 존재 여부 미누설)
      throw new NotFoundException('invalid or expired invite code');
    }
    const lease = Lease.create({
      unitId: payload.unitId,
      tenantId: input.tenantId,
    });
    return this.leases.save(lease);
  }
}
