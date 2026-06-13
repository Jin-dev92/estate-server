import { HttpStatus } from '@nestjs/common';
import { AppErrorSpec } from '../common/errors/app-exception';

export const PropertyError = {
  BUILDING_NOT_FOUND: {
    code: 'PROPERTY_BUILDING_NOT_FOUND',
    status: HttpStatus.NOT_FOUND,
    message: '건물을 찾을 수 없습니다.',
  },
  NOT_BUILDING_OWNER: {
    code: 'PROPERTY_NOT_BUILDING_OWNER',
    status: HttpStatus.FORBIDDEN,
    message: '건물 소유자만 할 수 있습니다.',
  },
  UNIT_NOT_FOUND: {
    code: 'PROPERTY_UNIT_NOT_FOUND',
    status: HttpStatus.NOT_FOUND,
    message: '호실을 찾을 수 없습니다.',
  },
  INVALID_INVITE_CODE: {
    code: 'PROPERTY_INVALID_INVITE_CODE',
    status: HttpStatus.NOT_FOUND,
    message: '유효하지 않거나 만료된 초대코드입니다.',
  },
  LEASE_NOT_FOUND: {
    code: 'PROPERTY_LEASE_NOT_FOUND',
    status: HttpStatus.NOT_FOUND,
    message: '계약을 찾을 수 없습니다.',
  },
  LEASE_ALREADY_ENDED: {
    code: 'PROPERTY_LEASE_ALREADY_ENDED',
    status: HttpStatus.CONFLICT,
    message: '이미 종료된 계약입니다.',
  },
} as const satisfies Record<string, AppErrorSpec>;
