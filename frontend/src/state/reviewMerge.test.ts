import { beforeEach, describe, expect, it } from 'vitest';
import { restoreLastSession, useStore } from './store';
import {
  MISSING_K,
  PHANTOM_CATALOG,
  buildFaultyFrames,
  createAnalyticVolume,
  volumeToFrames,
} from '../core/phantom';
import { ijkToWorld } from '../core/geometry';
import type { ImageFrame } from '../core/types';

const def = PHANTOM_CATALOG[0];

function reset() {
  localStorage.clear();
  useStore.setState({
    doc: { version: 2, sessions: {}, lastDatasetId: null, imports: {}, reviewBranches: {} },
    volume: null,
    loadError: null,
    pendingImport: null,
    pendingPatch: null,
    pendingReviewMerge: null,
    lastUpdate: null,
    lastMerge: null,
    reviewBranches: {},
    slices: [0, 0, 0],
    cursorIJK: null,
    measurements: [],
    draftPoint: null,
    measureMode: false,
  });
}

beforeEach(reset);

function openGapped(label = def.label) {
  const { frames } = buildFaultyFrames(def, 'missing');
  useStore.getState().requestImport(frames, label, { center: 120, width: 240 });
  useStore.getState().confirmImport();
}

function frameForLayer(k: number, name: string, mark: number): ImageFrame {
  const base = volumeToFrames(createAnalyticVolume(def), true)[def.dimensions[2] - 1 - k];
  const pixels = Float32Array.from(base.pixelData);
  pixels[2 + 2 * def.dimensions[0]] = mark;
  return { ...base, pixelData: pixels, sourceName: name };
}

function measure(k1: number, k2: number) {
  const volume = useStore.getState().volume!;
  useStore.getState().recordMeasurePoint(ijkToWorld([2, 2, k1], volume.origin, volume.direction, volume.spacing));
  useStore.getState().recordMeasurePoint(ijkToWorld([2, 2, k2], volume.origin, volume.direction, volume.spacing));
}

function patchFill(side: 'a' | 'b') {
  useStore.getState().requestPatch([frameForLayer(MISSING_K, `${side}/fill.dcm`, side === 'a' ? 210 : 211)], `${side} 补缺`);
  useStore.getState().confirmPatch();
}

function patchConflict(side: 'a' | 'b') {
  useStore.getState().requestPatch([frameForLayer(9, `${side}/layer-9.dcm`, side === 'a' ? 230 : 240)], `${side} 替换第 9 层`);
  const pending = useStore.getState().pendingPatch!;
  useStore.getState().setPatchChoice(pending.analysis.assessments[0].sourceIndex, true);
  useStore.getState().confirmPatch();
}

function patchLayer(side: 'a' | 'b', layer: number, mark: number) {
  useStore.getState().requestPatch(
    [frameForLayer(layer, `${side}/layer-${layer}.dcm`, mark)],
    `${side} 替换第 ${layer} 层`,
  );
  const pending = useStore.getState().pendingPatch!;
  useStore.getState().setPatchChoice(pending.analysis.assessments[0].sourceIndex, true);
  useStore.getState().confirmPatch();
}

describe('两份独立审阅合并', () => {
  it('逐层分类冲突，未处理层保持不确定；依据切片仍被采用的跨层测量可沿用', () => {
    openGapped(`${def.label} A`);
    useStore.getState().requestPatch([frameForLayer(MISSING_K, 'a/fill.dcm', 210)], 'A 补缺');
    useStore.getState().confirmPatch();
    measure(8, 11);
    patchConflict('a');
    while (useStore.getState().measurements.some((m) => m.review === 'pending')) {
      const pendingMeasurement = useStore.getState().measurements.find((m) => m.review === 'pending')!;
      useStore.getState().confirmMeasurement(pendingMeasurement.id);
    }
    useStore.getState().saveReviewSide('a', '审阅 A');

    openGapped(`${def.label} B`);
    useStore.getState().requestPatch([frameForLayer(MISSING_K, 'b/fill.dcm', 210)], 'B 补缺');
    useStore.getState().confirmPatch();
    measure(8, 11);
    patchConflict('b');
    while (useStore.getState().measurements.some((m) => m.review === 'pending')) {
      const pendingMeasurement = useStore.getState().measurements.find((m) => m.review === 'pending')!;
      useStore.getState().confirmMeasurement(pendingMeasurement.id);
    }
    useStore.getState().saveReviewSide('b', '审阅 B');

    useStore.getState().requestReviewMerge();
    let pending = useStore.getState().pendingReviewMerge!;
    const byStatus = pending.analysis.layers.reduce<Record<string, typeof pending.analysis.layers>>((acc, layer) => {
      (acc[layer.status] ??= []).push(layer);
      return acc;
    }, {});
    expect(byStatus.agreement?.length ?? 0).toBeGreaterThan(0);
    expect(byStatus.duplicate?.length ?? 0).toBeGreaterThan(0);
    expect(byStatus['content-conflict']?.map((layer) => layer.layer)).toEqual([9]);
    expect(pending.analysis.unresolvedLayers).toEqual([9]);

    expect(() => useStore.getState().confirmReviewMerge()).not.toThrow();
    expect(useStore.getState().pendingReviewMerge).not.toBeNull();
    expect(useStore.getState().volume?.id).toContain('#review-b');

    useStore.getState().setReviewMergeChoice(9, 'a');
    pending = useStore.getState().pendingReviewMerge!;
    expect(pending.analysis.unresolvedLayers).toEqual([]);
    useStore.getState().confirmReviewMerge();

    const merged = useStore.getState().volume!;
    expect(merged.mergeSources?.a).toContain('#review-a');
    expect(merged.mergeSources?.b).toContain('#review-b');
    expect(merged.sliceManifest?.[MISSING_K].status).toBe('adopted');
    const measurements = useStore.getState().measurements;
    expect(measurements).toHaveLength(2);
    expect(measurements[0].review).toBe('confirmed');
    expect(measurements[1].review).toBe('pending');
    expect(measurements[0].basisLayers).toEqual([8, 9, 10, 11]);
    expect(measurements[0].basisSlices).toHaveLength(4);
    expect(measurements[0].basisSlices?.every((item) => item.hash.startsWith('px-'))).toBe(true);
  });

  it('保存重开后仍能指出实际切片集合；撤回合并恢复缺片、跨层测量和来源版本', () => {
    openGapped(`${def.label} 撤回 A`);
    measure(7, 10);
    patchFill('a');
    const beforeMergeMeasurements = useStore.getState().measurements;
    useStore.getState().saveReviewSide('a', '审阅 A');
    openGapped(`${def.label} 撤回 B`);
    measure(7, 10);
    patchFill('b');
    useStore.getState().saveReviewSide('b', '审阅 B');
    useStore.getState().requestReviewMerge();
    useStore.getState().setReviewMergeChoice(MISSING_K, 'b');
    useStore.getState().confirmReviewMerge();
    const mergedId = useStore.getState().volume!.id;

    useStore.setState({
      volume: null,
      pendingReviewMerge: null,
      measurements: [],
      slices: [0, 0, 0],
      cursorIJK: null,
    });
    restoreLastSession();
    expect(useStore.getState().volume!.id).toBe(mergedId);
    const restoredMeasurements = useStore.getState().measurements;
    expect(restoredMeasurements[0].basisLayers).toEqual([7, 8, 9, 10]);
    expect(restoredMeasurements[0].basisSlices?.map((item) => item.layer)).toEqual([7, 8, 9, 10]);

    useStore.getState().undoReviewMerge();
    const state = useStore.getState();
    expect(state.volume!.id).toContain('#review-b');
    expect(state.measurements).toHaveLength(1);
    expect(state.measurements[0].distance).toBe(beforeMergeMeasurements[0].distance);
    expect(state.measurements[0].basisLayers).toEqual([7, 8, 9, 10]);
    expect(state.lastMerge).toBeNull();
  });

  it('逐层决定在关闭预览与页面后保留，可单独撤回另选，合并版可独立重开', () => {
    openGapped(`${def.label} 决定 A`);
    patchLayer('a', 10, 230);
    patchLayer('a', 12, 231);
    measure(9, 11); // 两端在 9/11 层，中间依据第 10 层
    useStore.getState().saveReviewSide('a', '审阅 A');
    const branchA = useStore.getState().reviewBranches.a!;

    openGapped(`${def.label} 决定 B`);
    patchLayer('b', 10, 240);
    patchLayer('b', 12, 241);
    measure(9, 11);
    useStore.getState().saveReviewSide('b', '审阅 B');
    const branchB = useStore.getState().reviewBranches.b!;
    const branchAImport = JSON.stringify(useStore.getState().doc.imports[branchA.id]);

    useStore.getState().requestReviewMerge();
    let pending = useStore.getState().pendingReviewMerge!;
    const byStatus = pending.analysis.layers.reduce<Record<string, number>>((acc, layer) => {
      acc[layer.status] = (acc[layer.status] ?? 0) + 1;
      return acc;
    }, {});
    // 共同来源且未改动的层是一致决定，不是重复导入
    expect(byStatus.agreement ?? 0).toBeGreaterThan(0);
    expect(byStatus.duplicate ?? 0).toBe(0);
    expect(pending.analysis.layers.find((l) => l.status === 'agreement')?.reason).toContain('共同来源');
    expect(pending.analysis.unresolvedLayers).toEqual([10, 12]);

    // 两处冲突分别选边后关闭预览：决定保留，不回到待定
    useStore.getState().setReviewMergeChoice(10, 'a');
    useStore.getState().setReviewMergeChoice(12, 'b');
    useStore.getState().cancelReviewMerge();
    useStore.getState().requestReviewMerge();
    pending = useStore.getState().pendingReviewMerge!;
    expect(pending.analysis.layers[10].selected).toBe('a');
    expect(pending.analysis.layers[12].selected).toBe('b');
    expect(pending.analysis.unresolvedLayers).toEqual([]);

    // 关闭页面后继续：逐层决定仍然保留
    useStore.setState({ volume: null, pendingReviewMerge: null, measurements: [], slices: [0, 0, 0], cursorIJK: null });
    restoreLastSession();
    useStore.getState().requestReviewMerge();
    pending = useStore.getState().pendingReviewMerge!;
    expect(pending.analysis.layers[10].selected).toBe('a');
    expect(pending.analysis.layers[12].selected).toBe('b');

    useStore.getState().confirmReviewMerge();
    const merged = useStore.getState().volume!;
    expect(merged.mergeSources).toEqual({ a: branchA.id, b: branchB.id });
    // A 侧测量依据（第 10 层取 A）不变 → 保持确认；B 侧测量中间依据层被换 → 待复核
    let measurements = useStore.getState().measurements;
    expect(measurements.find((m) => m.id.startsWith('a-'))?.review).toBe('confirmed');
    expect(measurements.find((m) => m.id.startsWith('b-'))?.review).toBe('pending');
    useStore.getState().confirmMeasurement(measurements.find((m) => m.id.startsWith('b-'))!.id);

    // 撤回其中一层并另选：其他已确认层决定不动
    useStore.getState().requestReviewMerge();
    useStore.getState().setReviewMergeChoice(10, null);
    pending = useStore.getState().pendingReviewMerge!;
    expect(pending.analysis.layers[12].selected).toBe('b');
    expect(pending.analysis.unresolvedLayers).toEqual([10]);
    useStore.getState().setReviewMergeChoice(10, 'b');
    useStore.getState().confirmReviewMerge();

    // 来源审阅未被合并改动
    expect(JSON.stringify(useStore.getState().doc.imports[branchA.id])).toBe(branchAImport);
    expect(useStore.getState().reviewBranches.b).toEqual(branchB);
    // 撤回另选后：A 侧测量中间依据层已变 → 重新待复核；B 侧依据完整 → 确认
    measurements = useStore.getState().measurements;
    const fromA = measurements.find((m) => m.id.startsWith('a-'))!;
    const fromB = measurements.find((m) => m.id.startsWith('b-'))!;
    expect(fromA.review).toBe('pending');
    expect(fromA.basisLayers).toEqual([9, 10, 11]);
    expect(fromB.review).toBe('confirmed');
    expect(fromB.basisSlices?.map((item) => item.layer)).toEqual([9, 10, 11]);

    // 保存后的合并版可独立重开，不需要重新预览找回工作
    const mergedId = useStore.getState().volume!.id;
    useStore.setState({ volume: null, pendingReviewMerge: null, measurements: [], slices: [0, 0, 0], cursorIJK: null });
    restoreLastSession();
    expect(useStore.getState().volume!.id).toBe(mergedId);
    expect(useStore.getState().volume!.mergeSources).toEqual({ a: branchA.id, b: branchB.id });
    expect(useStore.getState().measurements.map((m) => m.review)).toEqual(['pending', 'confirmed']);
  });
});
