import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
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
import { CreateBuildingDto } from './dto/create-building.dto';
import { CreateUnitDto } from './dto/create-unit.dto';
import { RedeemInviteDto } from './dto/redeem-invite.dto';

@Controller()
export class PropertyController {
  constructor(
    private readonly createBuilding: CreateBuildingUseCase,
    private readonly createUnit: CreateUnitUseCase,
    private readonly issueInvite: IssueInviteCodeUseCase,
    private readonly redeemInvite: RedeemInviteCodeUseCase,
    private readonly listMyBuildings: ListMyBuildingsUseCase,
    private readonly listMyLeases: ListMyLeasesUseCase,
  ) {}

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.OWNER)
  @Post('buildings')
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
  async issueInviteHandler(
    @CurrentUser() user: TokenPayload,
    @Param('unitId') unitId: string,
  ) {
    return this.issueInvite.execute({ ownerId: user.sub, unitId });
  }

  @UseGuards(JwtAuthGuard)
  @Post('invite-codes/redeem')
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
  async myLeasesHandler(@CurrentUser() user: TokenPayload) {
    const leases = await this.listMyLeases.execute(user.sub);
    return leases.map((l) => ({
      id: l.id,
      unitId: l.unitId,
      status: l.status,
    }));
  }
}
