export const MEMBERSHIP_CHECKER = Symbol('MEMBERSHIP_CHECKER');

export interface MembershipChecker {
  // 건물주이거나 해당 건물 호실의 ACTIVE 입주자면 true
  isMember(userId: string, buildingId: string): Promise<boolean>;
}
