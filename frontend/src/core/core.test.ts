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
import { analyzeFrameImport, buildVolumeFromAnalysis } from './importAnalysis';

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

  it('整批层序翻转：识别为合法翻转而非乱序/冲突', () => {
    const { frames } = buildFaultyFrames(def, 'none');
    const a = analyzeFrameImport(frames);
    expect(a.ok).toBe(true);
    expect(a.reversedOrder).toBe(true);
    expect(a.shuffled).toBe(false);
    expect(a.reasons).toHaveLength(0);
    expect(a.warnings.join(' ')).toContain('层序翻转');
  });

  it('乱序帧可重排，重排后空间测量与原始体数据一致', () => {
    const original = createAnalyticVolume(def);
    const { frames } = buildFaultyFrames(def, 'shuffle');
    const a = analyzeFrameImport(frames);
    expect(a.ok).toBe(true);
    expect(a.shuffled).toBe(true);
    const rebuilt = buildVolumeFromAnalysis(frames, def.label, original.window, a);
    expect(rebuilt.spacing).toEqual(def.spacing);
    const p1 = ijkToWorld([2, 3, 4], original.origin, original.direction, original.spacing);
    const p2 = ijkToWorld([20, 15, 13], original.origin, original.direction, original.spacing);
    const r1 = ijkToWorld([2, 3, 4], rebuilt.origin, rebuilt.direction, rebuilt.spacing);
    const r2 = ijkToWorld([20, 15, 13], rebuilt.origin, rebuilt.direction, rebuilt.spacing);
    expect(r1).toEqual(p1);
    expect(distance(r1, r2)).toBeCloseTo(distance(p1, p2), 6);
    const layerSize = def.dimensions[0] * def.dimensions[1];
    for (let k = 0; k < def.dimensions[2]; k += 1) {
      expect(Array.from(rebuilt.data.subarray(k * layerSize, (k + 1) * layerSize))).toEqual(
        Array.from(original.data.subarray(k * layerSize, (k + 1) * layerSize)),
      );
    }
  });

  it('混合批次分别报告乱序、重复位置、缺片与相反方向', () => {
    const { frames } = buildFaultyFrames(def, 'mixed');
    const a = analyzeFrameImport(frames);
    expect(a.ok).toBe(false);
    const joined = a.reasons.join('\n');
    expect(joined).toContain('重复位置');
    expect(joined).toContain('相反');
    // 缺片不再是致命冲突：作为空缺槽位保留，等待补片
    expect(a.warnings.join('\n')).toContain('缺片');
    expect(a.missingSlots.length).toBeGreaterThan(0);
    expect(a.shuffled).toBe(true);
    expect(a.warnings.join(' ')).toContain('乱序');
  });

  it('相反方向混入会被当作方向翻转冲突，而非静默翻转', () => {
    const { frames } = buildFaultyFrames(def, 'none');
    const target = frames[4];
    frames[4] = {
      ...target,
      imageOrientationPatient: [
        [-target.imageOrientationPatient[0][0], -target.imageOrientationPatient[0][1], -target.imageOrientationPatient[0][2]],
        target.imageOrientationPatient[1],
      ],
    };
    const a = analyzeFrameImport(frames);
    expect(a.ok).toBe(false);
    expect(a.reasons.some((reason) => reason.includes('方向翻转冲突'))).toBe(true);
  });
});
