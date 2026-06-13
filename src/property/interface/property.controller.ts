import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/interface/jwt-auth.guard';
import { RolesGuard } from '../../auth/interface/roles.guard';
import { Roles } from '../../auth/interface/roles.decorator';
import { CurrentUser } from '../../auth/interface/current-user.decorator';
import { Role } from '../../auth/domain/role.enum';
import { TokenPayload } from '../../auth/domain/token-issuer';
import { CreateBuildingUseCase } from '../application/create-building.use-case';
import { CreateUnitUseCase } from '../application/create-unit.use-case';
import { IssueInviteCodeUseCase } from '../application/issue-invite-code.use-case';
import { RedeemInviteCodeUseCase } from '../application/redeem-invite-code.use-case';
import { ListMyBuildingsUseCase } from '../application/list-my-buildings.use-case';
import { ListMyLeasesUseCase } from '../application/list-my-leases.use-case';
import { EndLeaseUseCase } from '../application/end-lease.use-case';
import { CreateBuildingDto } from './dto/create-building.dto';
import { CreateUnitDto } from './dto/create-unit.dto';
import { RedeemInviteDto } from './dto/redeem-invite.dto';
import { ErrorResponseDto } from '../../common/errors/error-response.dto';
import { SWAGGER_BEARER_AUTH } from '../../common/swagger/swagger.constants';

@ApiTags('property')
// 모든 라우트가 JwtAuthGuard 로 보호되므로 클래스 레벨에 한 번만 선언한다.
@ApiBearerAuth(SWAGGER_BEARER_AUTH)
@Controller()
export class PropertyController {
  constructor(
    private readonly createBuilding: CreateBuildingUseCase,
    private readonly createUnit: CreateUnitUseCase,
    private readonly issueInvite: IssueInviteCodeUseCase,
    private readonly redeemInvite: RedeemInviteCodeUseCase,
    private readonly listMyBuildings: ListMyBuildingsUseCase,
    private readonly listMyLeases: ListMyLeasesUseCase,
    private readonly endLease: EndLeaseUseCase,
  ) {}

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.OWNER)
  @Post('buildings')
  @ApiOperation({ summary: '건물 생성(OWNER 전용)' })
  @ApiResponse({ status: 201, description: '생성된 건물' })
  @ApiResponse({
    status: 403,
    type: ErrorResponseDto,
    description: 'OWNER 권한 없음',
  })
  async createBuildingHandler(
    @CurrentUser() user: TokenPayload,
    @Body() dto: CreateBuildingDto,
  ) {
    const building = await this.createBuilding.execute({
      ownerId: user.sub,
      name: dto.name,
      address: dto.address,
    });
    return {
      id: building.id,
      name: building.name,
      address: building.address,
    };
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.OWNER)
  @Get('buildings')
  @ApiOperation({ summary: '내 건물 목록 조회(OWNER 전용)' })
  @ApiResponse({ status: 200, description: '내가 소유한 건물 목록' })
  @ApiResponse({
    status: 403,
    type: ErrorResponseDto,
    description: 'OWNER 권한 없음',
  })
  async listBuildingsHandler(@CurrentUser() user: TokenPayload) {
    const buildings = await this.listMyBuildings.execute(user.sub);
    return buildings.map((b) => ({
      id: b.id,
      name: b.name,
      address: b.address,
    }));
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.OWNER)
  @Post('buildings/:buildingId/units')
  @ApiParam({ name: 'buildingId', description: '호실을 추가할 건물 ID' })
  @ApiOperation({ summary: '호실 생성(OWNER 전용)' })
  @ApiResponse({ status: 201, description: '생성된 호실' })
  @ApiResponse({
    status: 403,
    type: ErrorResponseDto,
    description: 'OWNER 권한 없음',
  })
  @ApiResponse({
    status: 404,
    type: ErrorResponseDto,
    description: '건물 없음',
  })
  async createUnitHandler(
    @CurrentUser() user: TokenPayload,
    @Param('buildingId') buildingId: string,
    @Body() dto: CreateUnitDto,
  ) {
    const unit = await this.createUnit.execute({
      ownerId: user.sub,
      buildingId,
      name: dto.name,
      floor: dto.floor,
    });
    return {
      id: unit.id,
      buildingId: unit.buildingId,
      name: unit.name,
      floor: unit.floor,
    };
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.OWNER)
  @Post('units/:unitId/invite-codes')
  @ApiParam({ name: 'unitId', description: '초대코드를 발급할 호실 ID' })
  @ApiOperation({ summary: '초대코드 발급(OWNER 전용)' })
  @ApiResponse({ status: 201, description: '발급된 초대코드' })
  @ApiResponse({
    status: 403,
    type: ErrorResponseDto,
    description: 'OWNER 권한 없음',
  })
  @ApiResponse({
    status: 404,
    type: ErrorResponseDto,
    description: '호실 없음',
  })
  async issueInviteHandler(
    @CurrentUser() user: TokenPayload,
    @Param('unitId') unitId: string,
  ) {
    return this.issueInvite.execute({ ownerId: user.sub, unitId });
  }

  @UseGuards(JwtAuthGuard)
  @Post('invite-codes/redeem')
  @ApiOperation({ summary: '초대코드 사용(입주)' })
  @ApiResponse({
    status: 201,
    description: '생성된 임대(Lease). status ∈ ACTIVE | ENDED',
  })
  @ApiResponse({
    status: 404,
    type: ErrorResponseDto,
    description: '유효하지 않거나 만료된 초대코드',
  })
  async redeemInviteHandler(
    @CurrentUser() user: TokenPayload,
    @Body() dto: RedeemInviteDto,
  ) {
    const lease = await this.redeemInvite.execute({
      tenantId: user.sub,
      code: dto.code,
    });
    return { id: lease.id, unitId: lease.unitId, status: lease.status };
  }

  @UseGuards(JwtAuthGuard)
  @Get('me/leases')
  @ApiOperation({ summary: '내 임대 목록 조회' })
  @ApiResponse({
    status: 200,
    description: '내 임대 목록. 각 status ∈ ACTIVE | ENDED',
  })
  async myLeasesHandler(@CurrentUser() user: TokenPayload) {
    const leases = await this.listMyLeases.execute(user.sub);
    return leases.map((l) => ({
      id: l.id,
      unitId: l.unitId,
      status: l.status,
    }));
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.OWNER)
  @Patch('leases/:id/end')
  @ApiOperation({ summary: '계약 종료(건물 OWNER 전용)' })
  @ApiParam({ name: 'id', description: '계약(Lease) ID' })
  @ApiResponse({ status: 200, description: '종료된 계약' })
  @ApiResponse({ status: 403, type: ErrorResponseDto, description: '건물 소유자 아님' })
  @ApiResponse({ status: 404, type: ErrorResponseDto, description: '계약 없음' })
  @ApiResponse({ status: 409, type: ErrorResponseDto, description: '이미 종료된 계약' })
  async endLeaseHandler(
    @CurrentUser() user: TokenPayload,
    @Param('id') id: string,
  ) {
    const lease = await this.endLease.execute({ userId: user.sub, leaseId: id });
    return {
      id: lease.id,
      unitId: lease.unitId,
      status: lease.status,
      endedAt: lease.endedAt,
    };
  }
}
