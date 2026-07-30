import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
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
import { RefreshTokensUseCase } from '../application/refresh-tokens.use-case';
import { LogoutUseCase } from '../application/logout.use-case';
import { LogoutAllUseCase } from '../application/logout-all.use-case';
import { ListSessionsUseCase } from '../application/list-sessions.use-case';
import { RevokeSessionUseCase } from '../application/revoke-session.use-case';
import { SignUpDto } from './dto/sign-up.dto';
import { LoginDto } from './dto/login.dto';
import { KakaoLoginDto, CompleteKakaoDto } from './dto/kakao.dto';
import {
  UpdateProfileDto,
  ProfileResponseDto,
  ChangePasswordDto,
} from './dto/profile.dto';
import { RefreshTokenDto, TokenPairResponseDto } from './dto/refresh.dto';
import { SessionResponseDto } from './dto/session.dto';
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
    private readonly refreshTokens: RefreshTokensUseCase,
    private readonly logoutUseCase: LogoutUseCase,
    private readonly logoutAllUseCase: LogoutAllUseCase,
    private readonly listSessions: ListSessionsUseCase,
    private readonly revokeSession: RevokeSessionUseCase,
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
  @ApiResponse({
    status: 201,
    type: TokenPairResponseDto,
    description: 'accessToken·refreshToken 토큰 쌍 반환',
  })
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
      '카카오 로그인(code 교환) — 기존 유저는 토큰 쌍, 신규는 onboardingToken',
  })
  @ApiResponse({
    status: 201,
    description:
      '기존 유저는 {accessToken, refreshToken} 토큰 쌍, 신규는 {onboardingToken}',
  })
  @ApiResponse({
    status: 400,
    type: ErrorResponseDto,
    description: '이메일 동의 필요 등',
  })
  @ApiResponse({
    status: 404,
    type: ErrorResponseDto,
    description: 'Account는 있으나 연결된 User 없음',
  })
  @ApiResponse({
    status: 503,
    type: ErrorResponseDto,
    description: '카카오 일시 장애(circuit open·포화·타임아웃) — M12',
  })
  kakaoLoginHandler(@Body() dto: KakaoLoginDto) {
    return this.kakaoLogin.execute(dto);
  }

  @Post('kakao/complete')
  @RateLimit({ ipMax: 10 })
  @ApiOperation({ summary: '카카오 신규 가입 완료(역할 선택)' })
  @ApiResponse({
    status: 201,
    type: TokenPairResponseDto,
    description: 'accessToken·refreshToken 토큰 쌍 반환',
  })
  @ApiResponse({
    status: 400,
    type: ErrorResponseDto,
    description: '유효하지 않은 role',
  })
  @ApiResponse({
    status: 401,
    type: ErrorResponseDto,
    description: 'onboarding 토큰 무효/만료',
  })
  @ApiResponse({
    status: 404,
    type: ErrorResponseDto,
    description: 'Account는 있으나 연결된 User 없음',
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

  @Post('refresh')
  @ApiOperation({
    summary: '토큰 갱신(회전)',
    description:
      '리프레시 토큰으로 새 토큰 쌍을 받는다. 기존 리프레시 토큰은 무효화된다. ' +
      '이미 사용된 토큰을 다시 제출하면 침해로 판단해 해당 세션 전체가 폐기된다.',
  })
  @ApiResponse({ status: 201, type: TokenPairResponseDto })
  @ApiResponse({
    status: 401,
    type: ErrorResponseDto,
    description: '무효한 리프레시 토큰 또는 재사용 탐지',
  })
  refresh(@Body() dto: RefreshTokenDto) {
    return this.refreshTokens.execute(dto.refreshToken);
  }

  @Post('logout')
  @ApiOperation({
    summary: '로그아웃(현재 세션 폐기)',
    description:
      '액세스 토큰이 이미 만료됐을 수 있으므로 리프레시 토큰으로 인증한다. 멱등하다.',
  })
  @ApiResponse({ status: 201, description: '폐기 완료' })
  async logout(@Body() dto: RefreshTokenDto): Promise<void> {
    await this.logoutUseCase.execute(dto.refreshToken);
  }

  @Post('logout-all')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth(SWAGGER_BEARER_AUTH)
  @ApiOperation({ summary: '전체 로그아웃(내 모든 세션 폐기)' })
  @ApiResponse({ status: 201, description: '폐기 완료' })
  @ApiResponse({
    status: 401,
    type: ErrorResponseDto,
    description: '인증 필요',
  })
  async logoutAll(@CurrentUser() user: TokenPayload): Promise<void> {
    await this.logoutAllUseCase.execute(user.sub);
  }

  @Get('sessions')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth(SWAGGER_BEARER_AUTH)
  @ApiOperation({
    summary: '내 활성 세션 목록',
    description:
      'ip·User-Agent를 저장하지 않으므로 기기 식별 정보는 제공하지 않는다. ' +
      '로그인 시각과 current 여부로만 구분한다.',
  })
  @ApiResponse({ status: 200, type: [SessionResponseDto] })
  @ApiResponse({
    status: 401,
    type: ErrorResponseDto,
    description: '인증 필요',
  })
  sessions(@CurrentUser() user: TokenPayload) {
    return this.listSessions.execute(user.sub, user.fam);
  }

  @Delete('sessions/:familyId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth(SWAGGER_BEARER_AUTH)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '특정 세션 폐기' })
  @ApiResponse({ status: 204, description: '폐기 완료' })
  @ApiResponse({
    status: 403,
    type: ErrorResponseDto,
    description: '본인 세션이 아님(존재하지 않는 세션도 동일)',
  })
  async revokeSessionById(
    @CurrentUser() user: TokenPayload,
    @Param('familyId') familyId: string,
  ): Promise<void> {
    await this.revokeSession.execute(user.sub, familyId);
  }
}
