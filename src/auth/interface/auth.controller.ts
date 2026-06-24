import { Body, Controller, Get, Patch, Post, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { SignUpUseCase } from '../application/sign-up.use-case';
import { LoginUseCase } from '../application/login.use-case';
import { GetProfileUseCase } from '../application/get-profile.use-case';
import { UpdateProfileUseCase } from '../application/update-profile.use-case';
import { SignUpDto } from './dto/sign-up.dto';
import { LoginDto } from './dto/login.dto';
import { UpdateProfileDto, ProfileResponseDto } from './dto/profile.dto';
import { JwtAuthGuard } from './jwt-auth.guard';
import { CurrentUser } from './current-user.decorator';
import { TokenPayload } from '../domain/token-issuer';
import { ErrorResponseDto } from '../../common/errors/error-response.dto';
import { SWAGGER_BEARER_AUTH } from '../../common/swagger/swagger.constants';
import { RateLimit } from '../../common/rate-limit/rate-limit.decorator';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly signUp: SignUpUseCase,
    private readonly login: LoginUseCase,
    private readonly getProfile: GetProfileUseCase,
    private readonly updateProfile: UpdateProfileUseCase,
  ) {}

  @Post('signup')
  @RateLimit({ ipMax: 10 })
  @ApiOperation({ summary: '회원가입' })
  @ApiResponse({ status: 201, description: '생성된 유저' })
  @ApiResponse({
    status: 400,
    type: ErrorResponseDto,
    description: '입력 검증 실패',
  })
  @ApiResponse({
    status: 409,
    type: ErrorResponseDto,
    description: '이메일 중복',
  })
  async signup(@Body() dto: SignUpDto) {
    const user = await this.signUp.execute(dto);
    return { id: user.id, email: user.email, name: user.name, role: user.role };
  }

  @Post('login')
  @RateLimit({ ipMax: 10 })
  @ApiOperation({ summary: '로그인(JWT 발급)' })
  @ApiResponse({ status: 201, description: 'accessToken 반환' })
  @ApiResponse({
    status: 401,
    type: ErrorResponseDto,
    description: '자격 증명 불일치',
  })
  loginHandler(@Body() dto: LoginDto) {
    return this.login.execute(dto);
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  @ApiBearerAuth(SWAGGER_BEARER_AUTH)
  @ApiOperation({ summary: '내 정보 조회' })
  @ApiResponse({ status: 200, description: 'role 포함(OWNER|TENANT|ADMIN)' })
  @ApiResponse({ status: 401, type: ErrorResponseDto })
  me(@CurrentUser() user: TokenPayload) {
    return { id: user.sub, email: user.email, role: user.role };
  }

  @UseGuards(JwtAuthGuard)
  @Get('profile')
  @ApiBearerAuth(SWAGGER_BEARER_AUTH)
  @ApiOperation({ summary: '프로필 조회(DB, name 포함)' })
  @ApiResponse({ status: 200, type: ProfileResponseDto })
  @ApiResponse({ status: 401, type: ErrorResponseDto })
  async profile(
    @CurrentUser() user: TokenPayload,
  ): Promise<ProfileResponseDto> {
    const u = await this.getProfile.execute(user.sub);
    return { id: u.id!, email: u.email, name: u.name, role: u.role };
  }

  @UseGuards(JwtAuthGuard)
  @Patch('profile')
  @ApiBearerAuth(SWAGGER_BEARER_AUTH)
  @ApiOperation({ summary: '프로필(이름) 수정' })
  @ApiResponse({ status: 200, type: ProfileResponseDto })
  @ApiResponse({ status: 401, type: ErrorResponseDto })
  async editProfile(
    @CurrentUser() user: TokenPayload,
    @Body() dto: UpdateProfileDto,
  ): Promise<ProfileResponseDto> {
    const u = await this.updateProfile.execute(user.sub, dto.name);
    return { id: u.id!, email: u.email, name: u.name, role: u.role };
  }
}
