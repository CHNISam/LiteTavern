import { describe, expect, it } from 'vitest';
import { calculateSquareCrop } from './avatar-image';

describe('avatar crop geometry', () => {
  it('uses a square source region and clamps movement inside the image', () => {
    expect(calculateSquareCrop(1600, 900, { zoom: 1, x: 0, y: 0 })).toEqual({
      sx: 350,
      sy: 0,
      size: 900
    });
    const moved = calculateSquareCrop(1600, 900, { zoom: 2, x: 1, y: -1 });
    expect(moved.size).toBe(450);
    expect(moved.sx).toBe(1150);
    expect(moved.sy).toBe(0);
  });
});
