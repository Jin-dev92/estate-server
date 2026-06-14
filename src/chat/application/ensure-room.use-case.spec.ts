import { EnsureRoomUseCase } from './ensure-room.use-case';
import { ChatRoom } from '../domain/chat-room.entity';
import { ChatRoomRepository } from '../domain/chat-room.repository';
import { BuildingRepository } from '../../property/domain/building.repository';
import { Building } from '../../property/domain/building.entity';
import { MembershipChecker } from '../../board/application/membership';

const BUILDING = 'b1';
const OWNER = 'owner1';
const TENANT = 't1';

function deps(
  opts: { existing?: ChatRoom | null; tenantIsMember?: boolean } = {},
) {
  const building = Building.reconstitute({
    id: BUILDING,
    ownerId: OWNER,
    name: '빌딩',
    address: '주소',
  });
  const saved: ChatRoom[] = [];
  const rooms: ChatRoomRepository = {
    save: (r) => {
      saved.push(r);
      return Promise.resolve(
        ChatRoom.reconstitute({
          id: 'r1',
          buildingId: r.buildingId,
          ownerId: r.ownerId,
          tenantId: r.tenantId,
        }),
      );
    },
    findById: () => Promise.resolve(null),
    findByBuildingAndTenant: () => Promise.resolve(opts.existing ?? null),
    findByParticipant: () => Promise.resolve([]),
  };
  const buildings: Partial<BuildingRepository> = {
    findById: () => Promise.resolve(building),
  };
  const membership: MembershipChecker = {
    isMember: () => Promise.resolve(opts.tenantIsMember ?? true),
  };
  return { rooms, buildings, membership, saved };
}

describe('EnsureRoomUseCase', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('OWNER가 입주자와 방을 만들면 ownerId/tenantId로 생성한다', async () => {
    // Arrange
    const { rooms, buildings, membership, saved } = deps();
    const useCase = new EnsureRoomUseCase(
      rooms,
      buildings as BuildingRepository,
      membership,
    );

    // Act
    const room = await useCase.execute({
      userId: OWNER,
      buildingId: BUILDING,
      tenantId: TENANT,
    });

    // Assert
    expect(saved[0].ownerId).toBe(OWNER);
    expect(saved[0].tenantId).toBe(TENANT);
    expect(room.id).toBe('r1');
  });

  it('이미 있으면 기존 방을 반환(멱등, save 안 함)', async () => {
    // Arrange
    const existing = ChatRoom.reconstitute({
      id: 'rX',
      buildingId: BUILDING,
      ownerId: OWNER,
      tenantId: TENANT,
    });
    const { rooms, buildings, membership, saved } = deps({ existing });
    const useCase = new EnsureRoomUseCase(
      rooms,
      buildings as BuildingRepository,
      membership,
    );

    // Act
    const room = await useCase.execute({
      userId: TENANT,
      buildingId: BUILDING,
      tenantId: TENANT,
    });

    // Assert
    expect(room.id).toBe('rX');
    expect(saved).toEqual([]);
  });

  it('호출자가 owner도 tenant도 아니면 NOT_ROOM_PARTICIPANT', async () => {
    // Arrange
    const { rooms, buildings, membership } = deps();
    const useCase = new EnsureRoomUseCase(
      rooms,
      buildings as BuildingRepository,
      membership,
    );

    // Act & Assert
    await expect(
      useCase.execute({
        userId: 'stranger',
        buildingId: BUILDING,
        tenantId: TENANT,
      }),
    ).rejects.toMatchObject({ code: 'CHAT_NOT_ROOM_PARTICIPANT' });
  });

  it('tenant가 건물 멤버가 아니면 TENANT_NOT_MEMBER', async () => {
    // Arrange
    const { rooms, buildings, membership } = deps({ tenantIsMember: false });
    const useCase = new EnsureRoomUseCase(
      rooms,
      buildings as BuildingRepository,
      membership,
    );

    // Act & Assert
    await expect(
      useCase.execute({
        userId: OWNER,
        buildingId: BUILDING,
        tenantId: TENANT,
      }),
    ).rejects.toMatchObject({ code: 'CHAT_TENANT_NOT_MEMBER' });
  });
});
