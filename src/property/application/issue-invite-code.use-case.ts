import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  BUILDING_REPOSITORY,
  BuildingRepository,
} from '../domain/building.repository';
import { UNIT_REPOSITORY, UnitRepository } from '../domain/unit.repository';
import {
  INVITE_CODE_STORE,
  InviteCodeStore,
  IssuedInvite,
} from '../domain/invite-code.store';

export interface IssueInviteCodeInput {
  ownerId: string;
  unitId: string;
}

@Injectable()
export class IssueInviteCodeUseCase {
  constructor(
    @Inject(UNIT_REPOSITORY) private readonly units: UnitRepository,
    @Inject(BUILDING_REPOSITORY) private readonly buildings: BuildingRepository,
    @Inject(INVITE_CODE_STORE) private readonly invites: InviteCodeStore,
  ) {}

  async execute(input: IssueInviteCodeInput): Promise<IssuedInvite> {
    const unit = await this.units.findById(input.unitId);
    if (!unit) throw new NotFoundException('unit not found');
    const building = await this.buildings.findById(unit.buildingId);
    if (!building || !building.isOwnedBy(input.ownerId)) {
      throw new ForbiddenException('not the building owner');
    }
    return this.invites.issue({ unitId: unit.id!, issuedBy: input.ownerId });
  }
}
