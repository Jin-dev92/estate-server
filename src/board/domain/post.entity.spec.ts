import { Post } from './post.entity';
import { PostCategory } from './post-category.enum';

describe('Post entity', () => {
  it('create()로 만들면 id는 null, 기본 category는 FREE, 작성자가 설정된다', () => {
    const post = Post.create({
      buildingId: 'b1',
      authorId: 'u1',
      title: '공지',
      content: '내용',
    });

    expect(post.id).toBeNull();
    expect(post.category).toBe(PostCategory.FREE);
    expect(post.isAuthoredBy('u1')).toBe(true);
    expect(post.isAuthoredBy('other')).toBe(false);
  });

  it('제목이 비면 예외', () => {
    expect(() =>
      Post.create({
        buildingId: 'b1',
        authorId: 'u1',
        title: '',
        content: '내용',
      }),
    ).toThrow('title is required');
  });

  it('edit()는 제목·본문이 바뀐 새 Post를 반환하고 id는 유지한다', () => {
    const post = Post.reconstitute({
      id: 'p1',
      buildingId: 'b1',
      authorId: 'u1',
      category: PostCategory.FREE,
      title: '원래',
      content: '원래본문',
    });

    const edited = post.edit({ title: '수정', content: '수정본문' });

    expect(edited.id).toBe('p1');
    expect(edited.title).toBe('수정');
    expect(edited.content).toBe('수정본문');
  });
});
