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
import { ChangePasswordUseCase } from '../application/change-password.use-case';
import { KakaoLoginUseCase } from '../application/kakao-login.use-case';
import { CompleteKakaoSignupUseCase } from '../application/complete-kakao-signup.use-case';
import { SignUpDto } from './dto/sign-up.dto';
import { LoginDto } from './dto/login.dto';
import { KakaoLoginDto, CompleteKakaoDto } from './dto/kakao.dto';
import {
  UpdateProfileDto,
  ProfileResponseDto,
  ChangePasswordDto,
} from './dto/profile.dto';
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
    private readonly changePassword: ChangePasswordUseCase,
    private readonly kakaoLogin: KakaoLoginUseCase,
    private readonly completeKakao: CompleteKakaoSignupUseCase,
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

  @Post('kakao')
  @RateLimit({ ipMax: 10 })
  @ApiOperation({
    summary:
      '카카오 로그인(code 교환) — 기존 유저는 accessToken, 신규는 onboardingToken',
  })
  @ApiResponse({
    status: 201,
    description: '{accessToken} 또는 {onboardingToken}',
  })
  @ApiResponse({
    status: 400,
    type: ErrorResponseDto,
    description: '이메일 동의 필요 등',
  })
  kakaoLoginHandler(@Body() dto: KakaoLoginDto) {
    return this.kakaoLogin.execute(dto);
  }

  @Post('kakao/complete')
  @RateLimit({ ipMax: 10 })
  @ApiOperation({ summary: '카카오 신규 가입 완료(역할 선택)' })
  @ApiResponse({ status: 201, description: 'accessToken 반환' })
  @ApiResponse({
    status: 401,
    type: ErrorResponseDto,
    description: 'onboarding 토큰 무효/만료',
  })
  @ApiResponse({
    status: 409,
    type: ErrorResponseDto,
    description: '이메일 중복',
  })
  completeKakaoHandler(@Body() dto: CompleteKakaoDto) {
    return this.completeKakao.execute(dto);
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
  @ApiResponse({
    status: 404,
    type: ErrorResponseDto,
    description: '사용자를 찾을 수 없음',
  })
  async profile(
    @CurrentUser() user: TokenPayload,
  ): Promise<ProfileResponseDto> {
    const u = await this.getProfile.execute(user.sub);
    return { id: u.id!, email: u.email, name: u.name, role: u.role };
  }

  @UseGuards(JwtAuthGuard)
  @Patch('profile')
  @RateLimit({ ipMax: 10 })
  @ApiBearerAuth(SWAGGER_BEARER_AUTH)
  @ApiOperation({ summary: '프로필(이름) 수정' })
  @ApiResponse({ status: 200, type: ProfileResponseDto })
  @ApiResponse({ status: 401, type: ErrorResponseDto })
  @ApiResponse({
    status: 404,
    type: ErrorResponseDto,
    description: '사용자를 찾을 수 없음',
  })
  async editProfile(
    @CurrentUser() user: TokenPayload,
    @Body() dto: UpdateProfileDto,
  ): Promise<ProfileResponseDto> {
    const u = await this.updateProfile.execute(user.sub, dto.name);
    return { id: u.id!, email: u.email, name: u.name, role: u.role };
  }

  @UseGuards(JwtAuthGuard)
  @Patch('password')
  @RateLimit({ ipMax: 10 })
  @ApiBearerAuth(SWAGGER_BEARER_AUTH)
  @ApiOperation({ summary: '비밀번호 변경' })
  @ApiResponse({
    status: 200,
    description: '변경 완료',
    schema: {
      type: 'object',
      properties: { ok: { type: 'boolean', example: true } },
    },
  })
  @ApiResponse({
    status: 401,
    type: ErrorResponseDto,
    description: '현재 비밀번호 불일치/인증 필요',
  })
  async editPassword(
    @CurrentUser() user: TokenPayload,
    @Body() dto: ChangePasswordDto,
  ): Promise<{ ok: true }> {
    await this.changePassword.execute(
      user.sub,
      dto.currentPassword,
      dto.newPassword,
    );
    return { ok: true };
  }
}
