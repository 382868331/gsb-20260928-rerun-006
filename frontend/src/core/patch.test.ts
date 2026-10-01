import { describe, expect, it } from 'vitest';
import {
  PHANTOM_CATALOG,
  MISSING_K,
  buildFaultyFrames,
  buildPatchBatch,
  createAnalyticVolume,
} from './phantom';
import { analyzeFrameImport, buildVolumeFromAnalysis } from './importAnalysis';
import {
  analyzePatch,
  applyPatch,
  measurementAffectedByLayers,
  measurementRangeStatus,
} from './patch';
import { ijkToWorld } from './geometry';
import type { Volume } from './types';

const def = PHANTOM_CATALOG[0];
const WINDOW = { center: 120, width: 240 };

// 构造含缺片槽位的体数据（缺片层以 NaN 占位保留）
function gappedVolume(): Volume {
  const { frames } = buildFaultyFrames(def, 'missing');
  const analysis = analyzeFrameImport(frames);
  expect(analysis.ok).toBe(true);
  expect(analysis.missingSlots.length).toBe(1);
  return buildVolumeFromAnalysis(frames, def.label, WINDOW, analysis);
}

describe('缺片槽位与补片', () => {
  it('缺片序列可组卷：缺片层以空缺槽位保留并记录在清单中', () => {
    const volume = gappedVolume();
    expect(volume.dimensions[2]).toBe(def.dimensions[2]);
    const missing = volume.sliceManifest!.filter((s) => s.status === 'missing');
    expect(missing).toHaveLength(1);
    expect(missing[0].layer).toBe(MISSING_K);
    // 缺片层体素为 NaN 占位
    const [nx, ny] = [volume.dimensions[0], volume.dimensions[1]];
    expect(Number.isNaN(volume.data[MISSING_K * nx * ny])).toBe(true);
    expect(volume.acquisitions).toHaveLength(1);
    expect(volume.acquisitions![0].kind).toBe('initial');
  });

  it('补片正好落入缺片槽位；其它位置的补片不会让缺片消失', () => {
    const volume = gappedVolume();
    const { frames, label } = buildPatchBatch(def, 'fill');
    const analysis = analyzePatch(volume, frames);
    expect(analysis.assessments).toHaveLength(1);
    expect(analysis.assessments[0].kind).toBe('fill-missing');
    expect(analysis.assessments[0].targetLayer).toBe(MISSING_K);

    const result = applyPatch(volume, frames, analysis, { 0: true }, label, 1000);
    expect(result.volume.sliceManifest!.every((s) => s.status === 'adopted')).toBe(true);
    expect(result.changedLayers).toEqual([MISSING_K]);
    // 数据集 id 稳定
    expect(result.volume.id).toBe(volume.id);
    // 填充的像素与原始体模一致
    const original = createAnalyticVolume(def);
    const [nx, ny] = [volume.dimensions[0], volume.dimensions[1]];
    expect(Array.from(result.volume.data.subarray(MISSING_K * nx * ny, (MISSING_K + 1) * nx * ny)))
      .toEqual(Array.from(original.data.subarray(MISSING_K * nx * ny, (MISSING_K + 1) * nx * ny)));

    // 若补片在别的位置（扩展层），缺片槽位仍然保留
    const { frames: replaceFrames } = buildPatchBatch(def, 'replace');
    const analysis2 = analyzePatch(volume, replaceFrames);
    const result2 = applyPatch(volume, replaceFrames, analysis2, { 0: true, 1: true }, '替换', 1001);
    const stillMissing = result2.volume.sliceManifest!.filter((s) => s.status === 'missing');
    expect(stillMissing).toHaveLength(1);
    expect(stillMissing[0].layer).toBe(MISSING_K);
  });

  it('替换片识别为重复位置；内容不同才计入变化层', () => {
    const volume = gappedVolume();
    const { frames } = buildPatchBatch(def, 'replace');
    const analysis = analyzePatch(volume, frames);
    expect(analysis.assessments.every((a) => a.kind === 'replacement')).toBe(true);
    expect(analysis.assessments.every((a) => a.differs)).toBe(true);
    // 默认不采用内容不同的替换片（由用户决定）
    expect(analysis.assessments.every((a) => !a.defaultAdopt)).toBe(true);

    const result = applyPatch(volume, frames, analysis, { 0: true, 1: false }, '替换片', 1002);
    // 只采用了第 0 帧（k=3）
    expect(result.changedLayers).toEqual([3]);
    // 被拒绝的替换片留有采用决定记录
    const decision = result.volume.sliceDecisions!.find((d) => d.rejected.length > 0);
    expect(decision).toBeTruthy();
    expect(decision!.adopted).toBeTruthy();
  });

  it('补片到达顺序不影响最终排列与内容', () => {
    const volume = gappedVolume();
    const { frames, label } = buildPatchBatch(def, 'mixed');
    const reversed = [...frames].reverse();

    const run = (batch: typeof frames, arrivedAt: number) => {
      const analysis = analyzePatch(volume, batch);
      const choices: Record<number, boolean> = {};
      for (const a of analysis.assessments) choices[a.sourceIndex] = a.defaultAdopt;
      return applyPatch(volume, batch, analysis, choices, label, arrivedAt);
    };
    const a = run(frames, 2000);
    const b = run(reversed, 2000);
    expect(Array.from(a.volume.data)).toEqual(Array.from(b.volume.data));
    expect(a.volume.sliceManifest).toEqual(b.volume.sliceManifest);
    expect(a.volume.origin).toEqual(b.volume.origin);
    expect(a.changedLayers).toEqual(b.changedLayers);
  });

  it('混合补片包逐帧分类：补片、替换、位置冲突、方向冲突、尺寸冲突', () => {
    const volume = gappedVolume();
    const { frames } = buildPatchBatch(def, 'mixed');
    const analysis = analyzePatch(volume, frames);
    const kinds = analysis.assessments.map((a) => a.kind);
    expect(kinds).toContain('fill-missing');
    expect(kinds).toContain('replacement');
    expect(kinds).toContain('off-grid');
    expect(kinds).toContain('conflict');
    // 冲突帧不可采用
    for (const a of analysis.assessments) {
      if (a.kind === 'conflict' || a.kind === 'off-grid') {
        expect(a.adoptable).toBe(false);
        expect(a.conflicts.length).toBeGreaterThan(0);
      }
    }
    // 采用可采用帧后：缺片被填补、替换生效、冲突帧不影响体数据
    const choices: Record<number, boolean> = {};
    for (const a of analysis.assessments) choices[a.sourceIndex] = a.adoptable;
    const result = applyPatch(volume, frames, analysis, choices, '混合', 3000);
    expect(result.volume.sliceManifest!.every((s) => s.status === 'adopted')).toBe(true);
    expect(result.volume.dimensions[2]).toBe(def.dimensions[2]);
  });

  it('全部拒绝时体数据保持不变', () => {
    const volume = gappedVolume();
    const { frames, label } = buildPatchBatch(def, 'fill');
    const analysis = analyzePatch(volume, frames);
    const result = applyPatch(volume, frames, analysis, { 0: false }, label, 4000);
    expect(Array.from(result.volume.data)).toEqual(Array.from(volume.data));
    expect(result.changedLayers).toEqual([]);
    expect(result.volume.sliceManifest).toEqual(volume.sliceManifest);
  });
});

describe('测量有效范围与受影响判定', () => {
  it('端点落在有效范围内 / 超出范围 / 位于缺片层', () => {
    const volume = gappedVolume();
    const p = (ijk: [number, number, number]) =>
      ijkToWorld(ijk, volume.origin, volume.direction, volume.spacing);
    expect(measurementRangeStatus(volume, { p1: p([1, 1, 1]), p2: p([3, 3, 3]) })).toBe('valid');
    expect(measurementRangeStatus(volume, { p1: p([1, 1, 1]), p2: p([1, 1, MISSING_K]) })).toBe('on-missing');
    expect(
      measurementRangeStatus(volume, { p1: p([1, 1, 1]), p2: p([1, 1, 999]) }),
    ).toBe('out-of-range');
  });

  it('只有端点落在变化层上的测量才算受影响', () => {
    const volume = gappedVolume();
    const p = (ijk: [number, number, number]) =>
      ijkToWorld(ijk, volume.origin, volume.direction, volume.spacing);
    const onChanged = { p1: p([2, 2, 3]), p2: p([4, 4, 3]) };
    const onOther = { p1: p([2, 2, 1]), p2: p([4, 4, 2]) };
    expect(measurementAffectedByLayers(volume, onChanged, [3])).toBe(true);
    expect(measurementAffectedByLayers(volume, onOther, [3])).toBe(false);
    expect(measurementAffectedByLayers(volume, onChanged, [])).toBe(false);
  });
});

