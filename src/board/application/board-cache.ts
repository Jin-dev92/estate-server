import { PostCategory } from '../domain/post-category.enum';

export const BOARD_CACHE = Symbol('BOARD_CACHE');

export interface PostSummary {
  id: string;
  category: PostCategory;
  title: string;
  authorId: string;
}

export interface CommentView {
  id: string;
  authorId: string;
  content: string;
}

export interface PostDetail {
  id: string;
  buildingId: string;
  category: PostCategory;
  title: string;
  content: string;
  authorId: string;
  comments: CommentView[];
}

// API 응답용 확장 타입. 좋아요 정보는 캐시에 넣지 않고 use-case가 라이브로 병합한다.
export interface PostSummaryView extends PostSummary {
  likeCount: number;
  likedByMe: boolean;
}

export interface PostDetailView extends PostDetail {
  likeCount: number;
  likedByMe: boolean;
}

export interface BoardCache {
  getList(buildingId: string): Promise<PostSummary[] | null>;
  setList(buildingId: string, posts: PostSummary[]): Promise<void>;
  getDetail(postId: string): Promise<PostDetail | null>;
  setDetail(postId: string, detail: PostDetail): Promise<void>;
  invalidateList(buildingId: string): Promise<void>;
  invalidateDetail(postId: string): Promise<void>;
}
