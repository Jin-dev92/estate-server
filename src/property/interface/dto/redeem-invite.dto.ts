import { IsNotEmpty } from 'class-validator';

export class RedeemInviteDto {
  @IsNotEmpty()
  code: string;
}
