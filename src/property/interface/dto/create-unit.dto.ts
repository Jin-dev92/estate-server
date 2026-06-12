import { IsInt, IsNotEmpty } from 'class-validator';

export class CreateUnitDto {
  @IsNotEmpty()
  name: string;

  @IsInt()
  floor: number;
}
