import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import { Role } from '../domain/role.enum';
import { AppException } from '../../common/errors/app-exception';

function contextWithUser(role: Role | undefined): ExecutionContext {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getRequest: () => ({ user: role ? { role } : undefined }),
    }),
  } as unknown as ExecutionContext;
}

function reflectorReturning(required: Role[] | undefined): Reflector {
  return {
    getAllAndOverride: () => required,
  } as unknown as Reflector;
}

describe('RolesGuard', () => {
  it('필요 역할이 없으면(메타데이터 없음) 통과', () => {
    const guard = new RolesGuard(reflectorReturning(undefined));

    expect(guard.canActivate(contextWithUser(Role.TENANT))).toBe(true);
  });

  it('역할이 일치하면 통과', () => {
    const guard = new RolesGuard(reflectorReturning([Role.OWNER]));

    expect(guard.canActivate(contextWithUser(Role.OWNER))).toBe(true);
  });

  it('역할이 부족하면 ForbiddenException', () => {
    const guard = new RolesGuard(reflectorReturning([Role.OWNER]));

    expect(() => guard.canActivate(contextWithUser(Role.TENANT))).toThrow(
      AppException,
    );
  });
});
