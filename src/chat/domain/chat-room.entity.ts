import { DomainError } from '../../common/errors/domain-error';

interface ChatRoomProps {
  id: string | null;
  buildingId: string;
  ownerId: string;
  tenantId: string;
}

export class ChatRoom {
  private constructor(private readonly props: ChatRoomProps) {}

  static create(input: { buildingId: string; ownerId: string; tenantId: string }): ChatRoom {
    if (!input.buildingId) throw new DomainError('건물 ID는 필수입니다.');
    if (!input.ownerId) throw new DomainError('건물주 ID는 필수입니다.');
    if (!input.tenantId) throw new DomainError('입주자 ID는 필수입니다.');
    return new ChatRoom({ id: null, ...input });
  }

  static reconstitute(props: ChatRoomProps): ChatRoom {
    return new ChatRoom(props);
  }

  isParticipant(userId: string): boolean {
    return this.props.ownerId === userId || this.props.tenantId === userId;
  }

  get id(): string | null {
    return this.props.id;
  }
  get buildingId(): string {
    return this.props.buildingId;
  }
  get ownerId(): string {
    return this.props.ownerId;
  }
  get tenantId(): string {
    return this.props.tenantId;
  }
}
