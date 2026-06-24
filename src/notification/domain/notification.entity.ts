import { EntityType } from '../../events/event-type.enum';
import { NotificationType } from './notification-type.enum';

export interface NotificationProps {
  id?: string;
  recipientId: string;
  type: NotificationType;
  title: string;
  body: string | null;
  entityType: EntityType;
  entityId: string;
  buildingId?: string | null;
  eventId: string;
  readAt: Date | null;
  createdAt?: Date;
}

// 한 수신자에게 전달되는 알림 한 건. 멱등 키는 (eventId, recipientId).
export class Notification {
  private constructor(private readonly props: NotificationProps) {}

  // 신규 생성: id·createdAt은 DB가 채우고, 항상 미읽음(readAt=null)으로 시작한다.
  static create(
    props: Omit<NotificationProps, 'id' | 'readAt' | 'createdAt'>,
  ): Notification {
    return new Notification({ ...props, readAt: null });
  }

  static reconstitute(props: NotificationProps): Notification {
    return new Notification(props);
  }

  get id(): string | undefined {
    return this.props.id;
  }
  get recipientId(): string {
    return this.props.recipientId;
  }
  get type(): NotificationType {
    return this.props.type;
  }
  get title(): string {
    return this.props.title;
  }
  get body(): string | null {
    return this.props.body;
  }
  get entityType(): EntityType {
    return this.props.entityType;
  }
  get entityId(): string {
    return this.props.entityId;
  }
  get buildingId(): string | null {
    return this.props.buildingId ?? null;
  }
  get eventId(): string {
    return this.props.eventId;
  }
  get readAt(): Date | null {
    return this.props.readAt;
  }
  get createdAt(): Date | undefined {
    return this.props.createdAt;
  }
}
