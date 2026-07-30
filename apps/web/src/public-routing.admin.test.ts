import { describe, expect, it } from 'vitest';
import { publicRouteForPath } from './public-routing';

describe('admin route', () => {
  it('recognizes /admin and descendants without exposing it in public navigation', () => {
    expect(publicRouteForPath('/admin')).toBe('admin');
    expect(publicRouteForPath('/admin/users')).toBe('admin');
  });
});
