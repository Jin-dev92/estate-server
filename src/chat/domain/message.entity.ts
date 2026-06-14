import { randomUUID } from 'node:crypto';
import { DomainError } from '../../common/errors/domain-error';

interface MessageProps {
  id: string;
  roomId: string;
  senderId: string;
  content: string;
  createdAt: Date;
}

export class Message {
  private constructor(private readonly props: MessageProps) {}

  // 새 메시지: messageId(uuid)·createdAt을 앱에서 생성한다(영속화 멱등 키).
  static create(input: { roomId: string; senderId: string; content: string }): Message {
    if (!input.content) throw new DomainError('내용은 필수입니다.');
    return new Message({
      id: randomUUID(),
      roomId: input.roomId,
      senderId: input.senderId,
      content: input.content,
      createdAt: new Date(),
    });
  }

  static reconstitute(props: MessageProps): Message {
    return new Message(props);
  }

  get id(): string {
    return this.props.id;
  }
  get roomId(): string {
    return this.props.roomId;
  }
  get senderId(): string {
    return this.props.senderId;
  }
  get content(): string {
    return this.props.content;
  }
  get createdAt(): Date {
    return this.props.createdAt;
  }
}
