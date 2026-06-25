import { plainToInstance } from 'class-transformer';
import { Trim } from './trim.decorator';

class Sample {
  @Trim()
  name!: string;
}

describe('Trim 데코레이터', () => {
  it('문자열의 앞뒤 공백을 제거한다', () => {
    const s = plainToInstance(Sample, { name: '  김철수  ' });
    expect(s.name).toBe('김철수');
  });

  it('공백만이면 빈 문자열이 된다(검증 단계에서 IsNotEmpty가 거른다)', () => {
    const s = plainToInstance(Sample, { name: '   ' });
    expect(s.name).toBe('');
  });

  it('문자열이 아니면 값을 그대로 둔다', () => {
    const s = plainToInstance(Sample, { name: 123 as unknown as string });
    expect(s.name).toBe(123);
  });
});
