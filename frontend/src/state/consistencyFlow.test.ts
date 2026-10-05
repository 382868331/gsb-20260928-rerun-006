import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from './store';
import {
  PHANTOM_CATALOG,
  buildFaultyFrames,
  createAnalyticVolume,
  volumeToFrames,
} from '../core/phantom';
import { ijkToWorld } from '../core/geometry';
import type { ImageFrame } from '../core/types';

const def = PHANTOM_CATALOG[0];
const taperDef = PHANTOM_CATALOG.find((d) => d.key === 'taper-even')!;
const stepDef = PHANTOM_CATALOG.find((d) => d.key === 'step-wide')!;

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

function openGapped(targetDef = def) {
  const { frames } = buildFaultyFrames(targetDef, 'missing');
  useStore.getState().requestImport(frames, targetDef.label, { center: 120, width: 240 });
  useStore.getState().confirmImport();
}

// 整层替换为均匀亮值：掩码边界与邻层显著不同，模拟可疑来源内容
function solidFrame(k: number, name: string, value: number): ImageFrame {
  const base = volumeToFrames(createAnalyticVolume(def), true)[def.dimensions[2] - 1 - k];
  const pixels = new Float32Array(base.pixelData.length).fill(value);
  return { ...base, pixelData: pixels, sourceName: name };
}

function patchLayer(frame: ImageFrame, label: string) {
  useStore.getState().requestPatch([frame], label);
  const pending = useStore.getState().pendingPatch!;
  useStore.getState().setPatchChoice(pending.analysis.assessments[0].sourceIndex, true);
  useStore.getState().confirmPatch();
}

function measure(k1: number, k2: number) {
  const volume = useStore.getState().volume!;
  useStore.getState().recordMeasurePoint(ijkToWorld([2, 2, k1], volume.origin, volume.direction, volume.spacing));
  useStore.getState().recordMeasurePoint(ijkToWorld([2, 2, k2], volume.origin, volume.direction, volume.spacing));
}

function saveIdenticalBranches(targetDef = def) {
  useStore.getState().openPhantom(targetDef);
  useStore.getState().saveReviewSide('a', '审阅 A');
  useStore.getState().openPhantom(targetDef);
  useStore.getState().saveReviewSide('b', '审阅 B');
  useStore.getState().requestReviewMerge();
}

describe('层间一致性辅助审阅', () => {
  it('连续形状不产生可疑跳变区间', () => {
    saveIdenticalBranches(taperDef);
    useStore.getState().runConsistencyCheck();
    const consistency = useStore.getState().pendingReviewMerge!.consistency!;
    expect(consistency.intervals).toEqual([]);
    expect(consistency.diagnostics.every((d) => !d.suspicious)).toBe(true);
    expect(consistency.diagnostics.every((d) => d.availableFraction === 1)).toBe(true);
  });

  it('真实突变被标记为可疑区间，但系统不自动替换任何决定', () => {
    saveIdenticalBranches(stepDef);
    const before = useStore.getState().pendingReviewMerge!;
    const selectedBefore = before.analysis.layers.map((layer) => layer.selected);

    useStore.getState().runConsistencyCheck();
    const pending = useStore.getState().pendingReviewMerge!;
    const intervals = pending.consistency!.intervals;
    expect(intervals).toHaveLength(1);
    expect(intervals[0].kind).toBe('source-difference');
    // 突变台在第 nz/2 层附近：第 6、7 层（0 基 5、6）
    expect(intervals[0].layers).toEqual([5, 6]);
    // 不凭视觉平滑自动替换：逐层选择与决定保持原样
    expect(pending.analysis.layers.map((layer) => layer.selected)).toEqual(selectedBefore);
    expect(pending.choices).toEqual({});
  });

  it('缺层与不同层间距：按物理距离判定缺层区间，不误报来源差异', () => {
    openGapped(stepDef); // 层间距 4.0mm，缺一层
    useStore.getState().saveReviewSide('a', '审阅 A');
    openGapped(stepDef);
    useStore.getState().saveReviewSide('b', '审阅 B');
    useStore.getState().requestReviewMerge();
    useStore.getState().runConsistencyCheck();

    const consistency = useStore.getState().pendingReviewMerge!.consistency!;
    // 缺片槽位按空间位置落槽：翻转法线下体素 k=nz/2 落在层 nz-1-k
    const missingLayer = stepDef.dimensions[2] - 1 - Math.floor(stepDef.dimensions[2] / 2);
    const kinds = new Set(consistency.intervals.map((interval) => interval.kind));
    expect(kinds).toEqual(new Set(['missing-slice']));
    // 缺层两侧物理间距 = 2 × 4.0mm，按 mm 而非层号判定
    const after = consistency.diagnostics[missingLayer + 1];
    expect(after.gapBeforeMm).toBeCloseTo(2 * stepDef.spacing[2], 6);
    expect(consistency.diagnostics[missingLayer].kind).toBe('missing-slice');
  });

  it('候选调整比较连续性与代价；修改一层仅邻域诊断过期，远处保持原依据', () => {
    // A 把第 9 层整层替换为均匀亮值（掩码与邻层显著不同），B 保持原片
    useStore.getState().openPhantom(def);
    patchLayer(solidFrame(9, 'a/solid-9.dcm', 150), 'A 替换第 9 层');
    measure(7, 11);
    useStore.getState().confirmMeasurement(
      useStore.getState().measurements.find((m) => m.review === 'pending')?.id ??
        useStore.getState().measurements[0].id,
    );
    useStore.getState().saveReviewSide('a', '审阅 A');
    useStore.getState().openPhantom(def);
    // B 侧不保留该测量：候选代价只统计 A 侧依据第 9 层的测量
    for (const m of useStore.getState().measurements) {
      useStore.getState().removeMeasurement(m.id);
    }
    useStore.getState().saveReviewSide('b', '审阅 B');
    useStore.getState().requestReviewMerge();

    useStore.getState().setReviewMergeChoice(9, 'a');
    useStore.getState().runConsistencyCheck();
    const first = useStore.getState().pendingReviewMerge!.consistency!;
    const diag9 = first.diagnostics[9];
    expect(diag9.suspicious).toBe(true);
    expect(diag9.kind).toBe('source-difference');

    // 建立候选调整：比较连续性提升与保留原选择的代价
    useStore.getState().proposeConsistencyCandidate(9);
    const candidate = useStore.getState().pendingReviewMerge!.consistency!.candidates[0];
    expect(candidate.to).toBe('b');
    expect(candidate.continuityAfter).toBeGreaterThan(candidate.continuityBefore);
    expect(candidate.costChangedDecisions).toBe(1);
    expect(candidate.costMeasurements).toBe(1);
    // 候选未批准前决定不变
    expect(useStore.getState().pendingReviewMerge!.analysis.layers[9].selected).toBe('a');

    // 批准：仅第 9 层进入新选择，邻域（8、9、10）诊断重算，远处诊断对象保持
    useStore.getState().approveConsistencyCandidate(9);
    const pending = useStore.getState().pendingReviewMerge!;
    expect(pending.analysis.layers[9].selected).toBe('b');
    const second = pending.consistency!;
    expect(second.diagnostics[9].suspicious).toBe(false);
    expect(second.diagnostics[8]).not.toBe(first.diagnostics[8]);
    expect(second.diagnostics[9]).not.toBe(first.diagnostics[9]);
    expect(second.diagnostics[10]).not.toBe(first.diagnostics[10]);
    expect(second.diagnostics[0]).toBe(first.diagnostics[0]);
    expect(second.diagnostics[15]).toBe(first.diagnostics[15]);
    expect(second.candidates).toEqual([]);
  });

  it('只有明确批准的层进入新合并版本，原始来源全部保留', () => {
    useStore.getState().openPhantom(def);
    patchLayer(solidFrame(9, 'a/solid-9.dcm', 150), 'A 替换第 9 层');
    useStore.getState().saveReviewSide('a', '审阅 A');
    useStore.getState().openPhantom(def);
    useStore.getState().saveReviewSide('b', '审阅 B');
    useStore.getState().requestReviewMerge();
    useStore.getState().setReviewMergeChoice(9, 'a');
    useStore.getState().runConsistencyCheck();

    // 建立候选但不批准：合并版本仍采用原选择（A 侧）
    useStore.getState().proposeConsistencyCandidate(9);
    useStore.getState().confirmReviewMerge();
    let merged = useStore.getState().volume!;
    expect(merged.id).toContain('merge:');
    expect(merged.sliceManifest?.[9].sourceName).toBe('a/solid-9.dcm');

    // 撤回后重开预览，批准候选：新合并版本第 9 层改用 B 侧原片
    useStore.getState().undoReviewMerge();
    useStore.getState().requestReviewMerge();
    useStore.getState().runConsistencyCheck();
    useStore.getState().proposeConsistencyCandidate(9);
    useStore.getState().approveConsistencyCandidate(9);
    useStore.getState().confirmReviewMerge();
    merged = useStore.getState().volume!;
    expect(merged.sliceManifest?.[9].sourceName).not.toBe('a/solid-9.dcm');

    // 原始来源保留：A/B 审阅分支影像不被合并版本覆盖
    const state = useStore.getState();
    const importA = state.doc.imports[state.reviewBranches.a!.id];
    const importB = state.doc.imports[state.reviewBranches.b!.id];
    expect(importA.frames.some((f) => f.sourceName === 'a/solid-9.dcm')).toBe(true);
    expect(importB.frames.some((f) => f.sourceName === 'a/solid-9.dcm')).toBe(false);
  });
});
