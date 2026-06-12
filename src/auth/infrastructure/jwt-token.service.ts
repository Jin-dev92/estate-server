import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { TokenIssuer, TokenPayload } from '../domain/token-issuer';

@Injectable()
export class JwtTokenService implements TokenIssuer {
  constructor(private readonly jwt: JwtService) {}

  issue(payload: TokenPayload): Promise<string> {
    return this.jwt.signAsync(payload);
  }
}
