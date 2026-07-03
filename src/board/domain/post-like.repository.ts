import { TransactionClient } from '../../outbox/domain/transaction-runner';

export const POST_LIKE_REPOSITORY = Symbol('POST_LIKE_REPOSITORY');

// 게시글 좋아요 저장소. like/unlike는 상태 전이 여부(bool)를 돌려준다 —
// DB 영향 행 수(rowCount) 기반이라, 이벤트 발행을 신규 좋아요일 때만 하도록 게이팅한다.
export interface PostLikeRepository {
  // INSERT ... ON CONFLICT DO NOTHING → 신규 생성이면 true.
  like(
    postId: string,
    userId: string,
    tx?: TransactionClient,
  ): Promise<boolean>;
  // DELETE WHERE postId,userId → 실제 삭제됐으면 true.
  unlike(
    postId: string,
    userId: string,
    tx?: TransactionClient,
  ): Promise<boolean>;
  // 단건 게시글 좋아요 수(라이브 COUNT).
  countByPost(postId: string): Promise<number>;
  // 목록용 배치: postId → 좋아요 수. 없는 글은 맵에 없음(호출측 0 처리).
  countByPosts(postIds: string[]): Promise<Map<string, number>>;
  // 목록용 배치: 주어진 글들 중 userId가 좋아요한 postId 집합.
  likedPostIds(userId: string, postIds: string[]): Promise<Set<string>>;
  // 상세용: 이 사용자가 이 글을 좋아요했는가.
  hasLiked(postId: string, userId: string): Promise<boolean>;
}
