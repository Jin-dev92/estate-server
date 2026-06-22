import { Inject, Injectable } from '@nestjs/common';
import { INVITE_CODE_STORE, InviteCodeStore } from '../domain/invite-code.store';
import { UNIT_REPOSITORY, UnitRepository } from '../domain/unit.repository';
import { BUILDING_REPOSITORY, BuildingRepository } from '../domain/building.repository';

export interface InvitePreview {
  valid: boolean;
  buildingName?: string;
  unitName?: string;
}

@Injectable()
export class PreviewInviteCodeUseCase {
  constructor(
    @Inject(INVITE_CODE_STORE) private readonly invites: InviteCodeStore,
    @Inject(UNIT_REPOSITORY) private readonly units: UnitRepository,
    @Inject(BUILDING_REPOSITORY) private readonly buildings: BuildingRepository,
  ) {}

  async execute(code: string): Promise<InvitePreview> {
    const payload = await this.invites.peek(code);
    if (!payload) return { valid: false };
    const unit = await this.units.findById(payload.unitId);
    if (!unit) return { valid: false };
    const building = await this.buildings.findById(unit.buildingId);
    if (!building) return { valid: false };
    // 보안: 코드가 비밀이므로 이름만 노출(주소·소유자 등 민감정보 제외)
    return { valid: true, buildingName: building.name, unitName: unit.name };
  }
}
