import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { TokenPayload } from '../domain/token-issuer';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): TokenPayload => {
    return ctx.switchToHttp().getRequest().user;
  },
);
