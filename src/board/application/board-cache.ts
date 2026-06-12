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

export interface BoardCache {
  getList(buildingId: string): Promise<PostSummary[] | null>;
  setList(buildingId: string, posts: PostSummary[]): Promise<void>;
  getDetail(postId: string): Promise<PostDetail | null>;
  setDetail(postId: string, detail: PostDetail): Promise<void>;
  invalidateList(buildingId: string): Promise<void>;
  invalidateDetail(postId: string): Promise<void>;
}
