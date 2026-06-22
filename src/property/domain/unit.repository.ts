import { Unit } from './unit.entity';

export const UNIT_REPOSITORY = Symbol('UNIT_REPOSITORY');

export interface UnitRepository {
  save(unit: Unit): Promise<Unit>;
  findById(id: string): Promise<Unit | null>;
  findByBuilding(buildingId: string): Promise<Unit[]>;
}
