import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { NotificationGateway } from './notification.gateway';
import {
  NotificationRelay,
  NotificationPushPayload,
} from '../domain/notification-relay';
import { Socket } from 'socket.io';

const SECRET = 'test-secret';

function makeGateway(relay: NotificationRelay) {
  const config = {
    getOrThrow: () => SECRET,
  } as unknown as ConfigService;
  const jwt = new JwtService({ secret: SECRET });
  return { gateway: new NotificationGateway(jwt, config, relay), jwt };
}

describe('NotificationGateway', () => {
  it('유효 토큰이면 user 룸에 join한다', () => {
    const relay: NotificationRelay = {
      publish: () => Promise.resolve(),
      subscribe: () => Promise.resolve(),
    };
    const { gateway, jwt } = makeGateway(relay);
    const token = jwt.sign({ sub: 'u1' });
    const joined: string[] = [];
    const client = {
      handshake: { auth: { token } },
      data: {},
      join: (room: string) => {
        joined.push(room);
        return Promise.resolve();
      },
      disconnect: jest.fn(),
    } as unknown as Socket;

    gateway.handleConnection(client);

    expect(joined).toEqual(['user:u1']);
  });

  it('잘못된 토큰이면 disconnect', () => {
    const relay: NotificationRelay = {
      publish: () => Promise.resolve(),
      subscribe: () => Promise.resolve(),
    };
    const { gateway } = makeGateway(relay);
    const disconnect = jest.fn();
    const client = {
      handshake: { auth: { token: 'bad' } },
      data: {},
      join: () => Promise.resolve(),
      disconnect,
    } as unknown as Socket;

    gateway.handleConnection(client);

    expect(disconnect).toHaveBeenCalled();
  });

  it('onModuleInit: relay 수신 시 user 룸으로 emit', async () => {
    let handler: ((p: NotificationPushPayload) => void) | undefined;
    const relay: NotificationRelay = {
      publish: () => Promise.resolve(),
      subscribe: (h) => {
        handler = h;
        return Promise.resolve();
      },
    };
    const { gateway } = makeGateway(relay);
    const emitted: Array<{ room: string; payload: unknown }> = [];
    gateway.server = {
      to: (room: string) => ({
        emit: (_evt: string, payload: unknown) =>
          emitted.push({ room, payload }),
      }),
    } as unknown as NotificationGateway['server'];

    await gateway.onModuleInit();
    handler?.({
      recipientId: 'u1',
      notification: {
        id: 'n1',
        type: 'PostAdded',
        title: '새 게시글',
        body: '제목',
        entityType: 'Post',
        entityId: 'p1',
        buildingId: 'b1',
        createdAt: '2026-06-15T00:00:00.000Z',
      },
    });

    expect(emitted).toHaveLength(1);
    expect(emitted[0].room).toBe('user:u1');
  });
});
