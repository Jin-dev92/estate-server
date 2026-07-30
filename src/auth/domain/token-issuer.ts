import { Role } from './role.enum';

export const TOKEN_ISSUER = Symbol('TOKEN_ISSUER');

export interface TokenPayload {
  sub: string;
  email: string;
  role: Role;
  // 이 액세스 토큰이 파생된 리프레시 토큰 가족(= 세션) 식별자.
  // GET /auth/sessions 가 current 세션을 표시하기 위해 필요하다.
  // 회전해도 값이 유지되므로 갱신 후에도 같은 세션으로 인식된다.
  fam: string;
}

export interface TokenIssuer {
  issue(payload: TokenPayload): Promise<string>;
}
