import { describe, expect, it } from 'vitest';
import {
  distance,
  ijkToWorld,
  worldToIjk,
  mat3Determinant,
  directionLabel,
} from './geometry';
import { buildVolumeFromFrames } from './series';
import { VolumeBuildError } from './types';
import {
  PHANTOM_CATALOG,
  buildFaultyFrames,
  buildPhantomFromFrames,
  createAnalyticVolume,
  phantomId,
} from './phantom';
import { extractSlice, planeToWorld } from './slices';

const def = PHANTOM_CATALOG[0];

describe('方向与间距几何', () => {
  it('翻转层序时方向行列式为 -1', () => {
    const volume = createAnalyticVolume(def);
    expect(mat3Determinant(volume.direction)).toBeCloseTo(-1, 6);
  });

  it('间距按体素物理间距解释，而非数组下标', () => {
    const volume = createAnalyticVolume(def);
    const a = ijkToWorld([0, 0, 0], volume.origin, volume.direction, volume.spacing);
    const b = ijkToWorld([3, 0, 0], volume.origin, volume.direction, volume.spacing);
    expect(distance(a, b)).toBeCloseTo(3 * 1.2, 6);
    const c = ijkToWorld([0, 2, 0], volume.origin, volume.direction, volume.spacing);
    expect(distance(a, c)).toBeCloseTo(2 * 0.8, 6);
    const d = ijkToWorld([0, 0, 4], volume.origin, volume.direction, volume.spacing);
    expect(distance(a, d)).toBeCloseTo(4 * 2.5, 6);
  });

  it('翻转 k 轴时递增体素索引向足侧移动', () => {
    const volume = createAnalyticVolume(def);
    const p0 = ijkToWorld([0, 0, 0], volume.origin, volume.direction, volume.spacing);
    const p1 = ijkToWorld([0, 0, 1], volume.origin, volume.direction, volume.spacing);
    expect(p1[2] - p0[2]).toBeCloseTo(-2.5, 6);
    expect(directionLabel([p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]])).toBe('I');
  });

  it('worldToIjk 是 ijkToWorld 的逆变换', () => {
    const volume = createAnalyticVolume(def);
    const p = ijkToWorld([7, 9, 11], volume.origin, volume.direction, volume.spacing);
    const ijk = worldToIjk(p, volume.origin, volume.direction, volume.spacing);
    expect(ijk[0]).toBeCloseTo(7, 6);
    expect(ijk[1]).toBeCloseTo(9, 6);
    expect(ijk[2]).toBeCloseTo(11, 6);
  });
});

describe('三视图同点对应', () => {
  it('标记点在轴向/冠状/矢状切片的同一患者坐标出现', () => {
    const volume = createAnalyticVolume(def);
    const [mx, my, mz] = def.markerIjk;
    const world = ijkToWorld([mx, my, mz], volume.origin, volume.direction, volume.spacing);

    const axial = extractSlice(volume, 2, mz);
    const coronal = extractSlice(volume, 1, my);
    const sagittal = extractSlice(volume, 0, mx);

    // 各视图中标记点所在像素反算回患者坐标必须相同
    expect(planeToWorld(volume, 2, mz, mx, my)).toEqual(world);
    expect(planeToWorld(volume, 1, my, mx, mz)).toEqual(world);
    expect(planeToWorld(volume, 0, mx, my, mz)).toEqual(world);

    expect(axial[mx + my * volume.dimensions[0]]).toBe(255);
    expect(coronal[mx + mz * volume.dimensions[0]]).toBe(255);
    expect(sagittal[my + mz * volume.dimensions[1]]).toBe(255);
  });

  it('任意斜向两点距离等于 sqrt(sum (deltaI*spacing)^2)', () => {
    const volume = createAnalyticVolume(def);
    const p = ijkToWorld([2, 3, 4], volume.origin, volume.direction, volume.spacing);
    const q = ijkToWorld([8, 10, 9], volume.origin, volume.direction, volume.spacing);
    const expected = Math.sqrt((6 * 1.2) ** 2 + (7 * 0.8) ** 2 + (5 * 2.5) ** 2);
    expect(distance(p, q)).toBeCloseTo(expected, 6);
  });
});

describe('帧序列组卷', () => {
  it('翻转层序的合法序列可重建，且几何保持一致', () => {
    const rebuilt = buildPhantomFromFrames(def);
    expect(rebuilt.id).toBe(phantomId(def));
    expect(rebuilt.dimensions).toEqual(def.dimensions);
    expect(rebuilt.spacing.map((s) => Number(s.toFixed(4)))).toEqual(
      def.spacing.map((s) => Number(s.toFixed(4))),
    );
    expect(mat3Determinant(rebuilt.direction)).toBeCloseTo(-1, 6);
  });

  it('缺片时报告无法组成完整体数据', () => {
    const { frames, missingK } = buildFaultyFrames(def, 'missing');
    try {
      buildVolumeFromFrames(frames, def.label, { center: 120, width: 240 });
      throw new Error('应抛出 VolumeBuildError');
    } catch (e) {
      expect(e).toBeInstanceOf(VolumeBuildError);
      expect((e as VolumeBuildError).reasons.join(' ')).toContain('缺片');
      expect(missingK).toBeGreaterThanOrEqual(0);
    }
  });

  it('方向冲突时逐帧指出冲突', () => {
    const { frames } = buildFaultyFrames(def, 'conflict');
    try {
      buildVolumeFromFrames(frames, def.label, { center: 120, width: 240 });
      throw new Error('应抛出 VolumeBuildError');
    } catch (e) {
      expect(e).toBeInstanceOf(VolumeBuildError);
      expect((e as VolumeBuildError).reasons.join(' ')).toContain('方向');
    }
  });

  it('空序列与单帧均被拒绝', () => {
    expect(() => buildVolumeFromFrames([], 'x', { center: 0, width: 1 })).toThrow(VolumeBuildError);
    const one = buildFaultyFrames(def, 'none').frames.slice(0, 1);
    expect(() => buildVolumeFromFrames(one, 'x', { center: 0, width: 1 })).toThrow(VolumeBuildError);
  });
});
