import { Prisma } from '@prisma/client';
import { PrismaMessageRepository } from './prisma-message.repository';
import { PrismaService } from '../../prisma/prisma.service';
import { ChatMessagePayload } from '../domain/chat-message';

const payload: ChatMessagePayload = {
  roomId: 'r1', messageId: 'm1', senderId: 'u1', content: '안녕', createdAt: '2026-06-14T00:00:00.000Z',
};

function p2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' });
}

describe('PrismaMessageRepository.persist', () => {
  let prisma: { message: { create: jest.Mock; findMany: jest.Mock } };
  let repo: PrismaMessageRepository;

  beforeEach(() => {
    prisma = { message: { create: jest.fn(), findMany: jest.fn() } };
    repo = new PrismaMessageRepository(prisma as unknown as PrismaService);
  });
  afterEach(() => jest.clearAllMocks());

  it('messageId를 PK로 INSERT한다', async () => {
    prisma.message.create.mockResolvedValue({});

    await repo.persist(payload);

    expect(prisma.message.create).toHaveBeenCalledWith({
      data: { id: 'm1', roomId: 'r1', senderId: 'u1', content: '안녕', createdAt: new Date('2026-06-14T00:00:00.000Z') },
    });
  });

  it('중복 messageId(P2002)는 무시(멱등)', async () => {
    prisma.message.create.mockRejectedValue(p2002());

    await expect(repo.persist(payload)).resolves.toBeUndefined();
  });

  it('그 외 에러는 재던짐', async () => {
    prisma.message.create.mockRejectedValue(new Error('db down'));

    await expect(repo.persist(payload)).rejects.toThrow('db down');
  });
});
