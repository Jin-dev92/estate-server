import { PreviewInviteCodeUseCase } from './preview-invite-code.use-case';
import { Unit } from '../domain/unit.entity';
import { Building } from '../domain/building.entity';
import {
  InviteCodePayload,
  InviteCodeStore,
} from '../domain/invite-code.store';
import { UnitRepository } from '../domain/unit.repository';
import { BuildingRepository } from '../domain/building.repository';

const UNIT = Unit.reconstitute({
  id: 'u1',
  buildingId: 'b1',
  name: '1503호',
  floor: 15,
});
const BUILDING = Building.reconstitute({
  id: 'b1',
  ownerId: 'o1',
  name: '래미안 역삼',
  address: '서울 강남구',
});

function makeStore(payload: InviteCodePayload | null): InviteCodeStore {
  return {
    issue: () => Promise.resolve({ code: 'x', expiresInSec: 1 }),
    redeem: () => Promise.resolve(null),
    peek: () => Promise.resolve(payload),
  };
}
const units: Partial<UnitRepository> = {
  findById: () => Promise.resolve(UNIT),
};
const buildings: Partial<BuildingRepository> = {
  findById: () => Promise.resolve(BUILDING),
};

describe('PreviewInviteCodeUseCase', () => {
  it('유효한 코드면 valid=true와 건물/호실 이름을 반환', async () => {
    const useCase = new PreviewInviteCodeUseCase(
      makeStore({ unitId: 'u1', issuedBy: 'o1' }),
      units as UnitRepository,
      buildings as BuildingRepository,
    );
    const result = await useCase.execute('GOOD');
    expect(result).toEqual({
      valid: true,
      buildingName: '래미안 역삼',
      unitName: '1503호',
    });
  });

  it('만료·없는 코드면 valid=false (이름 없음)', async () => {
    const useCase = new PreviewInviteCodeUseCase(
      makeStore(null),
      units as UnitRepository,
      buildings as BuildingRepository,
    );
    const result = await useCase.execute('EXPIRED');
    expect(result).toEqual({ valid: false });
  });
});
