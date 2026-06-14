import { Inject, Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app-exception';
import { ChatError } from '../chat.errors';
import { ChatRoom } from '../domain/chat-room.entity';
import {
  CHAT_ROOM_REPOSITORY,
  ChatRoomRepository,
} from '../domain/chat-room.repository';
import {
  BUILDING_REPOSITORY,
  BuildingRepository,
} from '../../property/domain/building.repository';
import {
  MEMBERSHIP_CHECKER,
  MembershipChecker,
} from '../../board/application/membership';

export interface EnsureRoomInput {
  userId: string;
  buildingId: string;
  tenantId: string;
}

@Injectable()
export class EnsureRoomUseCase {
  constructor(
    @Inject(CHAT_ROOM_REPOSITORY) private readonly rooms: ChatRoomRepository,
    @Inject(BUILDING_REPOSITORY) private readonly buildings: BuildingRepository,
    @Inject(MEMBERSHIP_CHECKER) private readonly membership: MembershipChecker,
  ) {}

  async execute(input: EnsureRoomInput): Promise<ChatRoom> {
    // 건물 존재 여부 확인
    const building = await this.buildings.findById(input.buildingId);
    if (!building) throw new AppException(ChatError.BUILDING_NOT_FOUND);

    // 호출자는 건물주이거나, 본인이 tenant로 지정된 경우만 방을 만들 수 있다.
    const isOwner = building.ownerId === input.userId;
    const isTenantSelf = input.userId === input.tenantId;
    if (!isOwner && !isTenantSelf) {
      throw new AppException(ChatError.NOT_ROOM_PARTICIPANT);
    }

    // tenant가 그 건물의 실제 멤버(입주자)인지 검증한다.
    const tenantIsMember = await this.membership.isMember(
      input.tenantId,
      input.buildingId,
    );
    if (!tenantIsMember) throw new AppException(ChatError.TENANT_NOT_MEMBER);

    // ensure: 있으면 반환, 없으면 생성.
    const existing = await this.rooms.findByBuildingAndTenant(
      input.buildingId,
      input.tenantId,
    );
    if (existing) return existing;

    return this.rooms.save(
      ChatRoom.create({
        buildingId: input.buildingId,
        ownerId: building.ownerId,
        tenantId: input.tenantId,
      }),
    );
  }
}
