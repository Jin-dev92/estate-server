import { HttpStatus } from '@nestjs/common';
import { AppErrorSpec } from '../common/errors/app-exception';

export const BoardError = {
  POST_NOT_FOUND: {
    code: 'BOARD_POST_NOT_FOUND',
    status: HttpStatus.NOT_FOUND,
    message: '게시글을 찾을 수 없습니다.',
  },
  NOT_AUTHOR: {
    code: 'BOARD_NOT_AUTHOR',
    status: HttpStatus.FORBIDDEN,
    message: '글 작성자만 수정·삭제할 수 있습니다.',
  },
  NOT_BUILDING_MEMBER: {
    code: 'BOARD_NOT_BUILDING_MEMBER',
    status: HttpStatus.FORBIDDEN,
    message: '해당 건물의 멤버가 아닙니다.',
  },
} as const satisfies Record<string, AppErrorSpec>;
