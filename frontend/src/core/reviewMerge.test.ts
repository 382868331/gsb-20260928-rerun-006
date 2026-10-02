import { describe, expect, it } from 'vitest';
import { PHANTOM_CATALOG, MISSING_K, buildFaultyFrames, buildPatchBatch } from './phantom';
import { analyzeFrameImport, buildVolumeFromAnalysis } from './importAnalysis';
import { analyzePatch, applyPatch, measurementBasisLayers } from './patch';
import {
  analyzeReviewMerge,
  measurementUsesSlices,
  mergeReviews,
  withdrawMergeResolution,
} from './reviewMerge';
import { ijkToWorld } from './geometry';
import type { Measurement, ReviewBranch, Volume } from './types';

const def = PHANTOM_CATALOG[0];
const WINDOW = { center: 120, width: 240 };

function cloneVolume(volume: Volume): Volume {
  return {
    ...volume,
    origin: [...volume.origin] as Volume['origin'],
    spacing: [...volume.spacing] as Volume['spacing'],
    direction: [...volume.direction] as Volume['direction'],
    data: Float32Array.from(volume.data),
    sliceManifest: volume.sliceManifest?.map((s) => ({ ...s })),
    acquisitions: volume.acquisitions?.map((a) => ({ ...a })),
    sliceDecisions: volume.sliceDecisions?.map((d) => ({ ...d, adopted: d.adopted ? { ...d.adopted } : null, rejected: d.rejected.map((r) => ({ ...r })) })),
  };
}

function gappedBase(): Volume {
  const { frames } = buildFaultyFrames(def, 'missing');
  const analysis = analyzeFrameImport(frames);
  return buildVolumeFromAnalysis(frames, def.label, WINDOW, analysis);
}

function patchVolume(volume: Volume, mode: 'fill' | 'replace', label: string): Volume {
  const batch = buildPatchBatch(def, mode);
  const analysis = analyzePatch(volume, batch.frames);
  const choices = Object.fromEntries(analysis.assessments.map((a) => [a.sourceIndex, true]));
  return applyPatch(volume, batch.frames, analysis, choices, label).volume;
}

function mutateLayer(volume: Volume, layer: number, value: number): Volume {
  const [nx, ny] = volume.dimensions;
  volume.data[layer * nx * ny] = value;
  const slot = volume.sliceManifest?.[layer];
  if (slot) slot.contentHash = `${slot.contentHash ?? 'slice'}-${value}`;
  return volume;
}

function measurement(volume: Volume, k1: number, k2: number, id: string): Measurement {
  const p1 = ijkToWorld([2, 2, k1], volume.origin, volume.direction, volume.spacing);
  const p2 = ijkToWorld([5, 5, k2], volume.origin, volume.direction, volume.spacing);
  const result: Measurement = {
    id,
    p1,
    p2,
    distance: 0,
    createdAt: 1,
    review: 'confirmed',
  };
  result.distance = Math.sqrt(
    (p1[0] - p2[0]) ** 2 + (p1[1] - p2[1]) ** 2 + (p1[2] - p2[2]) ** 2,
  );
  result.basisLayers = measurementBasisLayers(volume, result);
  return result;
}

function branch(id: string, label: string, volume: Volume, measurements: Measurement[]): ReviewBranch {
  return { id, label, baseAcquisitionId: 'acq-1', volume, measurements, createdAt: 1 };
}

describe('双审阅独立保存与逐层合并', () => {
  it('区分决定一致、同位置不同内容、相同内容重复导入和缺片后补入', () => {
    const base = gappedBase();
    const volumeA = patchVolume(cloneVolume(base), 'fill', 'A 补缺');
    const volumeBFill = patchVolume(cloneVolume(base), 'fill', 'B 补缺');
    const volumeB = mutateLayer(patchVolume(cloneVolume(volumeBFill), 'replace', 'B 替换'), 3, 254);

    const analysis = analyzeReviewMerge(volumeA, volumeB);
    const byLayer = new Map(analysis.items.map((item) => [item.layer, item]));
    expect(byLayer.get(1)?.status).toBe('identical-adopted');
    expect(byLayer.get(MISSING_K)?.status).toBe('same-content-duplicate');
    expect(byLayer.get(3)?.status).toBe('content-conflict');
    expect(byLayer.get(3)?.resolution).toBeNull();
  });

  it('未显式解决的内容冲突保持缺片；逐次预览不丢失其他选择', () => {
    const base = gappedBase();
    const volumeA = patchVolume(cloneVolume(base), 'replace', 'A 替换');
    const volumeB = mutateLayer(
      patchVolume(patchVolume(cloneVolume(base), 'fill', 'B 补缺'), 'replace', 'B 替换'),
      3,
      254,
    );
    mutateLayer(volumeB, 11, 253);
    const analysis = analyzeReviewMerge(volumeA, volumeB);
    const conflicts = analysis.items.filter((item) => item.conflicting).map((item) => item.layer);
    expect(conflicts).toEqual([3, 11]);

    let result = mergeReviews(
      branch('a', 'A', volumeA, []),
      branch('b', 'B', volumeB, []),
      { resolutions: { 3: 'a' } },
    );
    expect(result.analysis.unresolvedLayers).toEqual([11]);
    expect(result.volume.sliceManifest?.[3]?.sourceName).toContain('replace-slice-003');
    expect(result.volume.sliceManifest?.[11]?.status).toBe('missing');

    result = mergeReviews(
      branch('a', 'A', volumeA, []),
      branch('b', 'B', volumeB, []),
      { resolutions: { 3: 'a', 11: 'b' } },
    );
    expect(result.analysis.unresolvedLayers).toEqual([]);
    expect(result.volume.sliceManifest?.[3]?.contentHash).toBe(volumeA.sliceManifest?.[3]?.contentHash);
    expect(result.volume.sliceManifest?.[11]?.contentHash).toBe(volumeB.sliceManifest?.[11]?.contentHash);
  });

  it('跨层测量只在其完整切片集合仍被采用时沿用，并保存实际使用层', () => {
    const base = gappedBase();
    const volumeA = patchVolume(cloneVolume(base), 'fill', 'A 补缺');
    let volumeB = patchVolume(patchVolume(cloneVolume(gappedBase()), 'fill', 'B 补缺'), 'replace', 'B 替换');
    volumeB = mutateLayer(volumeB, 3, 254);
    mutateLayer(volumeB, 11, 253);
    const cross = measurement(volumeA, 2, 6, 'cross');
    const acrossFilled = measurement(volumeA, 7, 10, 'filled');
    const untouched = measurement(volumeA, 12, 14, 'safe');
    expect(cross.basisLayers?.map((b) => b.layer)).toEqual([2, 3, 4, 5, 6]);
    expect(acrossFilled.basisLayers?.map((b) => b.layer)).toEqual([7, MISSING_K, 9, 10]);

    const merged = mergeReviews(
      branch('a', 'A', volumeA, [cross, acrossFilled, untouched]),
      branch('b', 'B', volumeB, []),
      { resolutions: { 3: 'a', 11: 'b' } },
    );
    expect(merged.measurements[0].review).toBe('confirmed');
    expect(measurementUsesSlices(merged.measurements[0], merged.volume)).toEqual([2, 3, 4, 5, 6]);
    expect(measurementUsesSlices(merged.measurements[1], merged.volume)).toEqual([7, MISSING_K, 9, 10]);
    expect(merged.measurements[1].review).toBe('confirmed');
    expect(merged.measurements[2].review).toBe('confirmed');

    const changed = mergeReviews(
      branch('a', 'A', volumeA, [cross]),
      branch('b', 'B', volumeB, []),
      { resolutions: { 3: 'b', 11: 'b' } },
    );
    expect(changed.measurements[0].review).toBe('pending');
  });

  it('撤回合并层会恢复缺片、来源决定，并使跨层测量回到待复核', () => {
    const base = gappedBase();
    const volumeA = patchVolume(cloneVolume(base), 'fill', 'A 补缺');
    const volumeB = mutateLayer(
      patchVolume(patchVolume(cloneVolume(gappedBase()), 'fill', 'B 补缺'), 'replace', 'B 替换'),
      3,
      254,
    );
    const merged = mergeReviews(
      branch('a', 'A', volumeA, [measurement(volumeA, 2, 6, 'cross')]),
      branch('b', 'B', volumeB, []),
      { resolutions: { 3: 'a', 11: 'b' } },
    );
    const withdrawn = withdrawMergeResolution(merged.volume, merged.measurements, 3);
    expect(withdrawn.volume.sliceManifest?.[3]?.status).toBe('missing');
    expect(withdrawn.volume.reviewState?.withdrawnLayers).toContain(3);
    expect(withdrawn.volume.reviewState?.withdrawnResolutions?.[0]?.reviewId).toBe('a');
    expect(withdrawn.volume.reviewState?.withdrawnResolutions?.[0]?.contentHash).toBeTruthy();
    expect(withdrawn.measurements[0].review).toBe('pending');
  });
});
