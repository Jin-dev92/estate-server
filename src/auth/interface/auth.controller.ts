import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { SignUpUseCase } from '../application/sign-up.use-case';
import { LoginUseCase } from '../application/login.use-case';
import { SignUpDto } from './dto/sign-up.dto';
import { LoginDto } from './dto/login.dto';
import { JwtAuthGuard } from './jwt-auth.guard';
import { CurrentUser } from './current-user.decorator';
import { TokenPayload } from '../domain/token-issuer';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly signUp: SignUpUseCase,
    private readonly login: LoginUseCase,
  ) {}

  @Post('signup')
  async signup(@Body() dto: SignUpDto) {
    const user = await this.signUp.execute(dto);
    return { id: user.id, email: user.email, name: user.name, role: user.role };
  }

  @Post('login')
  loginHandler(@Body() dto: LoginDto) {
    return this.login.execute(dto);
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@CurrentUser() user: TokenPayload) {
    return { id: user.sub, email: user.email, role: user.role };
  }
}
