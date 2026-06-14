import { ChatRoom } from './chat-room.entity';

const BUILDING = 'b1';
const OWNER = 'owner1';
const TENANT = 't1';

describe('ChatRoom', () => {
  it('참가자(owner/tenant)는 isParticipant가 true', () => {
    const room = ChatRoom.reconstitute({
      id: 'r1',
      buildingId: BUILDING,
      ownerId: OWNER,
      tenantId: TENANT,
    });

    expect(room.isParticipant(OWNER)).toBe(true);
    expect(room.isParticipant(TENANT)).toBe(true);
  });

  it('제3자는 isParticipant가 false', () => {
    const room = ChatRoom.reconstitute({
      id: 'r1',
      buildingId: BUILDING,
      ownerId: OWNER,
      tenantId: TENANT,
    });

    expect(room.isParticipant('stranger')).toBe(false);
  });
});
