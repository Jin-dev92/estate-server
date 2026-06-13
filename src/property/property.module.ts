import { Module } from '@nestjs/common';
import { PropertyController } from './interface/property.controller';
import { CreateBuildingUseCase } from './application/create-building.use-case';
import { CreateUnitUseCase } from './application/create-unit.use-case';
import { IssueInviteCodeUseCase } from './application/issue-invite-code.use-case';
import { RedeemInviteCodeUseCase } from './application/redeem-invite-code.use-case';
import { ListMyBuildingsUseCase } from './application/list-my-buildings.use-case';
import { ListMyLeasesUseCase } from './application/list-my-leases.use-case';
import { EndLeaseUseCase } from './application/end-lease.use-case';
import { BUILDING_REPOSITORY } from './domain/building.repository';
import { UNIT_REPOSITORY } from './domain/unit.repository';
import { LEASE_REPOSITORY } from './domain/lease.repository';
import { INVITE_CODE_STORE } from './domain/invite-code.store';
import { PrismaBuildingRepository } from './infrastructure/prisma-building.repository';
import { PrismaUnitRepository } from './infrastructure/prisma-unit.repository';
import { PrismaLeaseRepository } from './infrastructure/prisma-lease.repository';
import { RedisInviteCodeStore } from './infrastructure/redis-invite-code.store';

@Module({
  controllers: [PropertyController],
  providers: [
    CreateBuildingUseCase,
    CreateUnitUseCase,
    IssueInviteCodeUseCase,
    RedeemInviteCodeUseCase,
    ListMyBuildingsUseCase,
    ListMyLeasesUseCase,
    EndLeaseUseCase,
    { provide: BUILDING_REPOSITORY, useClass: PrismaBuildingRepository },
    { provide: UNIT_REPOSITORY, useClass: PrismaUnitRepository },
    { provide: LEASE_REPOSITORY, useClass: PrismaLeaseRepository },
    { provide: INVITE_CODE_STORE, useClass: RedisInviteCodeStore },
  ],
})
export class PropertyModule {}
