import { Role } from './role.enum';

export const TOKEN_ISSUER = Symbol('TOKEN_ISSUER');

export interface TokenPayload {
  sub: string;
  email: string;
  role: Role;
}

export interface TokenIssuer {
  issue(payload: TokenPayload): Promise<string>;
}
