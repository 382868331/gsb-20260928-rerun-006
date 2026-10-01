import { describe, expect, it } from 'vitest';
import {
  PHANTOM_CATALOG,
  buildGappedBaseFrames,
  buildSupplementFrames,
  createAnalyticVolume,
} from './phantom';
import { buildGappedVolumeFromFrames } from './series';
import { ijkToWorld } from './geometry';
import {
  analyzeSupplement,
  applyCandidates,
  pointInValidRange,
  writeManifestData,
  type LayerManifest,
} from './supplement';

const def = PHANTOM_CATALOG[0];

function setupBase(missing: number[]) {
  const base = buildGappedBaseFrames(def, missing);
  const built = buildGappedVolumeFromFrames(base.frames, '缺片基底', { center: 120, width: 240 });
  const volume = built.volume;
  const layers: LayerManifest['layers'] = new Array(volume.dimensions[2]).fill(null);
  const ordered = base.frames
    .map((frame) => ({ frame, t: frameT(volume, frame) }))
    .sort((a, b) => a.t - b.t);
  ordered.forEach((item) => {
    const k = Math.round((item.t - ordered[0].t) / volume.spacing[2]);
    layers[k] = { frame: item.frame, batchId: 'base', adoptedAt: 0 };
  });
  const manifest: LayerManifest = { layers };
  volume.data.set(writeManifestData(volume, manifest));
  return { volume, manifest, missing: base.missingLayers };
}

function frameT(
  volume: ReturnType<typeof createAnalyticVolume>,
  frame: { imagePositionPatient: readonly number[] },
) {
  const colDir = [volume.direction[0], volume.direction[3], volume.direction[6]];
  const rowDir = [volume.direction[1], volume.direction[4], volume.direction[7]];
  const n = [
    rowDir[1] * colDir[2] - rowDir[2] * colDir[1],
    rowDir[2] * colDir[0] - rowDir[0] * colDir[2],
    rowDir[0] * colDir[1] - rowDir[1] * colDir[0],
  ];
  return (
    frame.imagePositionPatient[0] * n[0] +
    frame.imagePositionPatient[1] * n[1] +
    frame.imagePositionPatient[2] * n[2]
  );
}

describe('补片/替换片分析', () => {
  it('补片归类为 fill，缺片层保留且补其他位置不消除缺片', () => {
    const gaps = [5, 9];
    const { volume, manifest } = setupBase(gaps);
    const batch = buildSupplementFrames(def, { fillK: [gaps[1]], shuffle: false });
    const analysis = analyzeSupplement(volume, manifest, batch.frames, 'b1');
    const fill = analysis.candidates.filter((c) => c.kind === 'fill');
    expect(fill).toHaveLength(1);
    expect(fill[0].layer).toBe(gaps[1]);
    // 另一处缺片仍然存在
    expect(analysis.missingLayers.slice().sort((a, b) => a - b)).toEqual([5, 9]);
    expect(analysis.remainingMissingAfterAdopt).toEqual([5]);
  });

  it('替换片内容不同判为 replace，完全一致判为 duplicate', () => {
    const { volume, manifest } = setupBase([5]);
    const batch = buildSupplementFrames(def, {
      replaceK: [4],
      duplicateK: [10],
      shuffle: false,
    });
    const analysis = analyzeSupplement(volume, manifest, batch.frames, 'b1');
    const kinds = new Map(analysis.candidates.map((c) => [c.layer, c.kind]));
    expect(kinds.get(4)).toBe('replace');
    expect(kinds.get(10)).toBe('duplicate');
  });

  it('尺寸冲突与法线反向均判为 conflict 且不可采用', () => {
    const { volume, manifest } = setupBase([5]);
    const batch = buildSupplementFrames(def, {
      sizeConflictK: 6,
      orientationConflictK: 8,
      shuffle: false,
    });
    const analysis = analyzeSupplement(volume, manifest, batch.frames, 'b1');
    const conflicts = analysis.candidates.filter((c) => c.kind === 'conflict');
    expect(conflicts).toHaveLength(2);
    expect(conflicts.some((c) => c.issues.join(' ').includes('尺寸'))).toBe(true);
    expect(conflicts.some((c) => c.issues.join(' ').includes('法线反向'))).toBe(true);
  });

  it('补片到达顺序不同，最终排列一致', () => {
    const gaps = [5, 9];
    const { volume, manifest } = setupBase(gaps);
    const batchA = buildSupplementFrames(def, { fillK: [5, 9], shuffle: false });
    const batchB = buildSupplementFrames(def, { fillK: [9, 5], shuffle: true });
    const selA = new Set(batchA.frames.map((_, i) => i));
    const selB = new Set(batchB.frames.map((_, i) => i));
    const a = analyzeSupplement(volume, manifest, batchA.frames, 'a');
    const b = analyzeSupplement(volume, manifest, batchB.frames, 'b');
    const resultA = applyCandidates(manifest, a.candidates, selA, 'a', 1);
    const resultB = applyCandidates(manifest, b.candidates, selB, 'b', 2);
    expect(resultA.changedLayers.sort((x, y) => x - y)).toEqual([5, 9]);
    expect(resultB.changedLayers.sort((x, y) => x - y)).toEqual([5, 9]);
    const dataA = writeManifestData(volume, resultA.manifest);
    const dataB = writeManifestData(volume, resultB.manifest);
    expect(Array.from(dataA)).toEqual(Array.from(dataB));
    // 两处缺片都被填满
    expect(resultA.manifest.layers[5]?.batchId).toBe('a');
    expect(resultA.manifest.layers[9]).not.toBeNull();
  });

  it('补入另一位置的切片不会让缺片消失', () => {
    const { volume, manifest } = setupBase([5, 9]);
    // 试图把一张正常层的切片放到缺片层之外（同内容重复），缺片仍在
    const batch = buildSupplementFrames(def, { duplicateK: [3], shuffle: false });
    const analysis = analyzeSupplement(volume, manifest, batch.frames, 'b1');
    expect(analysis.remainingMissingAfterAdopt.sort((a, b) => a - b)).toEqual([5, 9]);
  });

  it('有效性判定：缺片层上的点不在有效影像范围内，补入后恢复', () => {
    const { volume, manifest } = setupBase([5]);
    const worldOnGap = ijkToWorld([10, 10, 5], volume.origin, volume.direction, volume.spacing);
    const worldOnLayer = ijkToWorld([10, 10, 6], volume.origin, volume.direction, volume.spacing);
    expect(pointInValidRange(volume, manifest, worldOnGap)).toBe(false);
    expect(pointInValidRange(volume, manifest, worldOnLayer)).toBe(true);

    const batch = buildSupplementFrames(def, { fillK: [5], shuffle: false });
    const analysis = analyzeSupplement(volume, manifest, batch.frames, 'b1');
    const result = applyCandidates(
      manifest,
      analysis.candidates,
      new Set(analysis.candidates.map((c) => c.sourceIndex)),
      'b1',
      1,
    );
    expect(pointInValidRange(volume, result.manifest, worldOnGap)).toBe(true);
  });

  it('替换改变内容时 changedLayers 精确命中被替换层，未触及层不标记', () => {
    const { volume, manifest } = setupBase([5]);
    const batch = buildSupplementFrames(def, { replaceK: [4], shuffle: false });
    const analysis = analyzeSupplement(volume, manifest, batch.frames, 'b1');
    const result = applyCandidates(
      manifest,
      analysis.candidates,
      new Set([0]),
      'b1',
      1,
    );
    expect(result.changedLayers).toEqual([4]);
    expect(result.manifest.layers[4]?.batchId).toBe('b1');
    expect(result.manifest.layers[6]?.batchId).toBe('base');
  });
});
