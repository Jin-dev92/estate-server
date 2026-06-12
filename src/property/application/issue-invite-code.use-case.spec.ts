import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { IssueInviteCodeUseCase } from './issue-invite-code.use-case';
import { Building } from '../domain/building.entity';
import { Unit } from '../domain/unit.entity';
import { BuildingRepository } from '../domain/building.repository';
import { UnitRepository } from '../domain/unit.repository';
import {
  InviteCodePayload,
  InviteCodeStore,
  IssuedInvite,
} from '../domain/invite-code.store';

const OWNER_ID = 'owner1';
const UNIT_ID = 'unit1';
const BUILDING_ID = 'b1';

const unitRepo: UnitRepository = {
  save: (u) => Promise.resolve(u),
  findById: (id) =>
    Promise.resolve(
      id === UNIT_ID
        ? Unit.reconstitute({
            id: UNIT_ID,
            buildingId: BUILDING_ID,
            name: '101호',
            floor: 1,
          })
        : null,
    ),
};

function buildingRepoOwnedBy(ownerId: string): BuildingRepository {
  return {
    save: (b) => Promise.resolve(b),
    findById: (id) =>
      Promise.resolve(
        id === BUILDING_ID
          ? Building.reconstitute({
              id: BUILDING_ID,
              ownerId,
              name: '래미안',
              address: '주소',
            })
          : null,
      ),
    findByOwner: () => Promise.resolve([]),
  };
}

class FakeInviteStore implements InviteCodeStore {
  public lastPayload: InviteCodePayload | null = null;
  issue(payload: InviteCodePayload): Promise<IssuedInvite> {
    this.lastPayload = payload;
    return Promise.resolve({ code: 'CODE123', expiresInSec: 86400 });
  }
  redeem(): Promise<InviteCodePayload | null> {
    return Promise.resolve(null);
  }
}

describe('IssueInviteCodeUseCase', () => {
  it('소유자가 발급하면 코드와 만료시간을 반환', async () => {
    const store = new FakeInviteStore();
    const useCase = new IssueInviteCodeUseCase(
      unitRepo,
      buildingRepoOwnedBy(OWNER_ID),
      store,
    );

    const result = await useCase.execute({ ownerId: OWNER_ID, unitId: UNIT_ID });

    expect(result.code).toBe('CODE123');
    expect(store.lastPayload).toEqual({ unitId: UNIT_ID, issuedBy: OWNER_ID });
  });

  it('소유자가 아니면 ForbiddenException', async () => {
    const useCase = new IssueInviteCodeUseCase(
      unitRepo,
      buildingRepoOwnedBy('someone-else'),
      new FakeInviteStore(),
    );

    await expect(
      useCase.execute({ ownerId: OWNER_ID, unitId: UNIT_ID }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('호실이 없으면 NotFoundException', async () => {
    const useCase = new IssueInviteCodeUseCase(
      unitRepo,
      buildingRepoOwnedBy(OWNER_ID),
      new FakeInviteStore(),
    );

    await expect(
      useCase.execute({ ownerId: OWNER_ID, unitId: 'nope' }),
    ).rejects.toThrow(NotFoundException);
  });
});
