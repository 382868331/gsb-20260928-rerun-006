import { beforeEach, describe, expect, it } from 'vitest';
import { restoreLastSession, useStore } from './store';
import {
  PHANTOM_CATALOG,
  MISSING_K,
  buildFaultyFrames,
  buildPatchBatch,
} from '../core/phantom';
import { ijkToWorld } from '../core/geometry';

const def = PHANTOM_CATALOG[0];
const WINDOW = { center: 120, width: 240 };

function reset() {
  localStorage.clear();
  useStore.setState({
    doc: { version: 2, sessions: {}, lastDatasetId: null, imports: {} },
    volume: null,
    loadError: null,
    pendingImport: null,
    pendingPatch: null,
    pendingMerge: null,
    reviewBranches: {},
    lastUpdate: null,
    slices: [0, 0, 0],
    cursorIJK: null,
    measurements: [],
    draftPoint: null,
    measureMode: false,
  });
}

beforeEach(reset);

// 载入缺片序列并确认，得到含缺片槽位的体数据
function openGapped() {
  const { frames } = buildFaultyFrames(def, 'missing');
  useStore.getState().requestImport(frames, def.label, WINDOW);
  useStore.getState().confirmImport();
  return useStore.getState().volume!;
}

function measureOnLayers(k1: [number, number, number], k2: [number, number, number]) {
  const v = useStore.getState().volume!;
  useStore.getState().recordMeasurePoint(ijkToWorld(k1, v.origin, v.direction, v.spacing));
  useStore.getState().recordMeasurePoint(ijkToWorld(k2, v.origin, v.direction, v.spacing));
}

describe('补片/替换片工作流', () => {
  it('补片填补缺片层，测量保持确认且在有效范围内', () => {
    openGapped();
    expect(useStore.getState().volume!.sliceManifest!.some((s) => s.status === 'missing')).toBe(true);
    measureOnLayers([2, 2, 2], [5, 5, 4]);

    const { frames, label } = buildPatchBatch(def, 'fill');
    useStore.getState().requestPatch(frames, label);
    expect(useStore.getState().pendingPatch).not.toBeNull();
    useStore.getState().confirmPatch();

    const state = useStore.getState();
    expect(state.volume!.sliceManifest!.every((s) => s.status === 'adopted')).toBe(true);
    expect(state.measurements[0].review).toBe('confirmed');
    expect(state.volume!.acquisitions).toHaveLength(2);
    expect(state.lastUpdate).not.toBeNull();
  });

  it('替换片改变内容时相关测量进入待复核，未受影响保持确认；复核后恢复', () => {
    openGapped();
    // 先补缺片，保证完整体数据
    const fill = buildPatchBatch(def, 'fill');
    useStore.getState().requestPatch(fill.frames, fill.label);
    useStore.getState().confirmPatch();
    // 一条在 k=3 上（替换片目标层），一条在 k=13 上（不受影响）
    measureOnLayers([2, 2, 3], [5, 5, 3]);
    measureOnLayers([2, 2, 13], [5, 5, 13]);
    expect(useStore.getState().measurements).toHaveLength(2);

    const replace = buildPatchBatch(def, 'replace'); // 替换 k=3 与 k=11
    useStore.getState().requestPatch(replace.frames, replace.label);
    // 采用全部替换候选
    const pending = useStore.getState().pendingPatch!;
    for (const a of pending.analysis.assessments) {
      useStore.getState().setPatchChoice(a.sourceIndex, true);
    }
    useStore.getState().confirmPatch();

    const measurements = useStore.getState().measurements;
    expect(measurements[0].review).toBe('pending');
    expect(measurements[1].review).toBe('confirmed');
    // 测量空间位置不变
    expect(measurements[0].distance).toBeGreaterThan(0);

    useStore.getState().confirmMeasurement(measurements[0].id);
    expect(useStore.getState().measurements[0].review).toBe('confirmed');
  });

  it('拒绝更新与撤销更新都回到原体数据', () => {
    openGapped();
    const before = useStore.getState().volume!;
    measureOnLayers([2, 2, 3], [5, 5, 3]);

    // 拒绝：取消预览后体数据不变
    const fill = buildPatchBatch(def, 'fill');
    useStore.getState().requestPatch(fill.frames, fill.label);
    useStore.getState().cancelPatch();
    expect(useStore.getState().volume).toBe(before);

    // 确认后撤销：回到更新前的体数据与测量状态
    useStore.getState().requestPatch(fill.frames, fill.label);
    useStore.getState().confirmPatch();
    expect(useStore.getState().volume).not.toBe(before);
    expect(useStore.getState().volume!.sliceManifest!.every((s) => s.status === 'adopted')).toBe(true);

    useStore.getState().undoPatch();
    const restored = useStore.getState();
    expect(restored.volume!.sliceManifest).toEqual(before.sliceManifest);
    expect(Array.from(restored.volume!.data)).toEqual(Array.from(before.data));
    expect(restored.measurements).toHaveLength(1);
    expect(restored.lastUpdate).toBeNull();
  });

  it('保存重开后保留每层采用决定与测量依据的采集版本', () => {
    openGapped();
    const fill = buildPatchBatch(def, 'fill');
    useStore.getState().requestPatch(fill.frames, fill.label);
    useStore.getState().confirmPatch();
    const replace = buildPatchBatch(def, 'replace');
    useStore.getState().requestPatch(replace.frames, replace.label);
    const pending = useStore.getState().pendingPatch!;
    // 采用第 0 帧、拒绝第 1 帧，留下采用/拒绝混合决定
    const sorted = [...pending.analysis.assessments].sort((a, b) => a.sourceIndex - b.sourceIndex);
    useStore.getState().setPatchChoice(sorted[0].sourceIndex, true);
    useStore.getState().setPatchChoice(sorted[1].sourceIndex, false);
    useStore.getState().confirmPatch();
    measureOnLayers([2, 2, 3], [5, 5, 3]);

    const beforeId = useStore.getState().volume!.id;
    const beforeDecisions = useStore.getState().volume!.sliceDecisions!;
    expect(beforeDecisions.some((d) => d.rejected.length > 0)).toBe(true);

    // 模拟重开
    useStore.setState({
      volume: null, pendingImport: null, pendingPatch: null, lastUpdate: null,
      slices: [0, 0, 0], cursorIJK: null, measurements: [],
    });
    restoreLastSession();
    const restored = useStore.getState();
    expect(restored.volume!.id).toBe(beforeId);
    expect(restored.volume!.sliceDecisions).toEqual(beforeDecisions);
    expect(restored.volume!.acquisitions).toHaveLength(3);
    expect(restored.volume!.sliceManifest!.every((s) => s.status === 'adopted')).toBe(true);
    expect(restored.measurements).toHaveLength(1);
    expect(restored.measurements[0].basisAcquisition).toBe('acq-3');
  });

  it('缺片序列确认导入后，缺片层仍标示为缺片（不被其它位置顶替）', () => {
    openGapped();
    const manifest = useStore.getState().volume!.sliceManifest!;
    const missing = manifest.filter((s) => s.status === 'missing');
    expect(missing).toHaveLength(1);
    expect(missing[0].layer).toBe(MISSING_K);
  });
});

describe('双审阅合并持久化', () => {
  it('保存重开后每个沿用测量都能指出实际使用的切片集合', () => {
    const base = openGapped();
    const fill = buildPatchBatch(def, 'fill');
    useStore.getState().requestPatch(fill.frames, fill.label);
    useStore.getState().confirmPatch();
    measureOnLayers([2, 2, 2], [5, 5, 10]);
    expect(useStore.getState().measurements[0].basisLayers?.map((b) => b.layer))
      .toEqual([2, 3, 4, 5, 6, 7, MISSING_K, 9, 10]);

    useStore.getState().createReviewBranch('review-a', '审阅 A');
    expect(useStore.getState().reviewBranches['review-a']).toBeTruthy();
    void base;

    const replace = buildPatchBatch(def, 'replace');
    useStore.getState().requestPatch(replace.frames, '审阅 B 替换');
    for (const assessment of useStore.getState().pendingPatch!.analysis.assessments) {
      useStore.getState().setPatchChoice(assessment.sourceIndex, true);
    }
    useStore.getState().confirmPatch();
    useStore.getState().createReviewBranch('review-b', '审阅 B');

    useStore.getState().requestMergeReviews('review-a', 'review-b');
    const pending = useStore.getState().pendingMerge!;
    expect([3, 11].every((layer) => !pending.resolutions[layer])).toBe(true);
    useStore.getState().setMergeResolution(3, 'a');
    useStore.getState().setMergeResolution(11, 'b');
    useStore.getState().confirmMergeReviews();
    expect(useStore.getState().pendingMerge).toBeNull();
    expect(useStore.getState().measurements[0].review).toBe('confirmed');
    expect(useStore.getState().measurements[0].basisLayers?.map((b) => b.layer))
      .toEqual([2, 3, 4, 5, 6, 7, MISSING_K, 9, 10]);

    useStore.setState({
      volume: null,
      pendingImport: null,
      pendingPatch: null,
      pendingMerge: null,
      reviewBranches: {},
      slices: [0, 0, 0],
      cursorIJK: null,
      measurements: [],
    });
    restoreLastSession();
    const restored = useStore.getState();
    expect(restored.measurements[0].review).toBe('confirmed');
    expect(restored.measurements[0].basisLayers?.map((b) => b.layer))
      .toEqual([2, 3, 4, 5, 6, 7, MISSING_K, 9, 10]);
    expect(restored.volume?.reviewState?.mergedFrom?.reviewIds).toEqual(['review-a', 'review-b']);
  });
});
