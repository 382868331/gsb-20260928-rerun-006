import { beforeEach, describe, expect, it } from 'vitest';
import { restoreLastSession, useStore } from './store';
import {
  PHANTOM_CATALOG,
  buildGappedBaseFrames,
  buildSupplementFrames,
} from '../core/phantom';
import { ijkToWorld } from '../core/geometry';

const def = PHANTOM_CATALOG[0];

function resetState() {
  useStore.setState({
    doc: { version: 1, sessions: {}, lastDatasetId: null, imports: {} },
    volume: null,
    loadError: null,
    pendingImport: null,
    manifest: null,
    adoptedBatches: [],
    pendingSupplement: null,
    slices: [0, 0, 0],
    cursorIJK: null,
    measurements: [],
    draftPoint: null,
    measureMode: false,
  });
}

beforeEach(() => {
  localStorage.clear();
  resetState();
});

describe('补片/替换片工作流', () => {
  it('打开缺片基底：缺层为空槽，其上测量标记为超出有效范围；补入后恢复在范围内', () => {
    const gaps = buildGappedBaseFrames(def).missingLayers;
    const gap = gaps[0];
    useStore.getState().openGappedFrames(
      buildGappedBaseFrames(def).frames,
      '缺片基底',
      { center: 120, width: 240 },
    );
    const volume = useStore.getState().volume!;
    const manifest = useStore.getState().manifest!;
    expect(manifest.layers[gap]).toBeNull();

    // 在缺片层做测量：保存的是患者坐标，标记越界
    const p1 = ijkToWorld([5, 5, gap], volume.origin, volume.direction, volume.spacing);
    const p2 = ijkToWorld([10, 10, gap], volume.origin, volume.direction, volume.spacing);
    useStore.getState().recordMeasurePoint(p1);
    useStore.getState().recordMeasurePoint(p2);
    const m = useStore.getState().measurements[0];
    expect(m.endpointsInRange).toBe(false);

    // 补入该层
    const batch = buildSupplementFrames(def, { fillK: [gap], shuffle: true });
    useStore.getState().requestSupplement(batch.frames);
    expect(useStore.getState().pendingSupplement).not.toBeNull();
    useStore.getState().confirmSupplement();
    const after = useStore.getState();
    expect(after.manifest!.layers[gap]?.batchId).toContain('batch-');
    // 补全改变了该层可见内容，测量进入待复核；但位置保持不变
    const mAfter = after.measurements[0];
    expect(mAfter.p1).toEqual(m.p1);
    expect(mAfter.p2).toEqual(m.p2);
    expect(mAfter.endpointsInRange).toBe(true);
    expect(mAfter.reviewStatus).toBe('review');

    // 人工复核确认
    useStore.getState().reconfirmMeasurement(mAfter.id);
    expect(useStore.getState().measurements[0].reviewStatus).toBe('confirmed');
  });

  it('替换片只影响命中层测量，未触及层测量保持已确认', () => {
    useStore.getState().openGappedFrames(
      buildGappedBaseFrames(def).frames,
      '缺片基底',
      { center: 120, width: 240 },
    );
    const volume = useStore.getState().volume!;
    // 命中层 4 上的测量
    const a1 = ijkToWorld([2, 2, 4], volume.origin, volume.direction, volume.spacing);
    const a2 = ijkToWorld([6, 6, 4], volume.origin, volume.direction, volume.spacing);
    useStore.getState().recordMeasurePoint(a1);
    useStore.getState().recordMeasurePoint(a2);
    // 未触及层 2 上的测量（默认缺片为 8、11 层）
    const b1 = ijkToWorld([2, 2, 2], volume.origin, volume.direction, volume.spacing);
    const b2 = ijkToWorld([6, 6, 2], volume.origin, volume.direction, volume.spacing);
    useStore.getState().recordMeasurePoint(b1);
    useStore.getState().recordMeasurePoint(b2);

    const batch = buildSupplementFrames(def, { replaceK: [4], shuffle: true });
    useStore.getState().requestSupplement(batch.frames);
    useStore.getState().confirmSupplement();
    const ms = useStore.getState().measurements;
    expect(ms[0].reviewStatus).toBe('review');
    expect(ms[1].reviewStatus ?? 'confirmed').toBe('confirmed');
    expect(ms[1].endpointsInRange).toBe(true);
  });

  it('补另一位置不会消除缺片；两个缺片槽位都保留直到各自补入', () => {
    const gaps = buildGappedBaseFrames(def).missingLayers;
    useStore.getState().openGappedFrames(
      buildGappedBaseFrames(def).frames,
      '缺片基底',
      { center: 120, width: 240 },
    );
    // 只补第二张缺片
    const b1 = buildSupplementFrames(def, { fillK: [gaps[1]], shuffle: true });
    useStore.getState().requestSupplement(b1.frames);
    const pending = useStore.getState().pendingSupplement!;
    expect(pending.analysis.remainingMissingAfterAdopt).toEqual([gaps[0]]);
    useStore.getState().confirmSupplement();
    const manifest = useStore.getState().manifest!;
    expect(manifest.layers[gaps[0]]).toBeNull();
    expect(manifest.layers[gaps[1]]).not.toBeNull();

    // 再补第一张
    const b2 = buildSupplementFrames(def, { fillK: [gaps[0]], shuffle: true });
    useStore.getState().requestSupplement(b2.frames);
    useStore.getState().confirmSupplement();
    const filled = useStore.getState().manifest!;
    expect(filled.layers[gaps[0]]).not.toBeNull();
    expect(filled.layers[gaps[1]]).not.toBeNull();
  });

  it('冲突帧默认不勾选且不能采用；拒绝批次则原体数据不变', () => {
    useStore.getState().openGappedFrames(
      buildGappedBaseFrames(def).frames,
      '缺片基底',
      { center: 120, width: 240 },
    );
    const before = useStore.getState().volume!;
    const batch = buildSupplementFrames(def, {
      sizeConflictK: 6,
      orientationConflictK: 8,
      shuffle: true,
    });
    useStore.getState().requestSupplement(batch.frames);
    const pending = useStore.getState().pendingSupplement!;
    const conflicts = pending.analysis.candidates.filter((c) => c.kind === 'conflict');
    expect(conflicts).toHaveLength(2);
    for (const c of conflicts) expect(pending.selected.has(c.sourceIndex)).toBe(false);
    // 冲突项无法被勾选
    useStore.getState().toggleCandidate(conflicts[0].sourceIndex);
    expect(useStore.getState().pendingSupplement!.selected.has(conflicts[0].sourceIndex)).toBe(false);
    // 拒绝：回到原数据
    useStore.getState().cancelSupplement();
    expect(useStore.getState().volume).toBe(before);
    expect(useStore.getState().adoptedBatches).toHaveLength(0);
  });

  it('撤销批次回到原体数据，相关测量复核状态回退', () => {
    useStore.getState().openGappedFrames(
      buildGappedBaseFrames(def).frames,
      '缺片基底',
      { center: 120, width: 240 },
    );
    const originalData = useStore.getState().volume!.data;
    const volume = useStore.getState().volume!;
    const q1 = ijkToWorld([3, 3, 4], volume.origin, volume.direction, volume.spacing);
    const q2 = ijkToWorld([8, 8, 4], volume.origin, volume.direction, volume.spacing);
    useStore.getState().recordMeasurePoint(q1);
    useStore.getState().recordMeasurePoint(q2);
    const batch = buildSupplementFrames(def, { replaceK: [4], shuffle: true });
    useStore.getState().requestSupplement(batch.frames);
    useStore.getState().confirmSupplement();
    expect(useStore.getState().adoptedBatches).toHaveLength(1);
    expect(useStore.getState().volume!.data).not.toBe(originalData);
    expect(useStore.getState().measurements[0].reviewStatus).toBe('review');

    useStore.getState().undoLastBatch();
    expect(useStore.getState().adoptedBatches).toHaveLength(0);
    const restoredData = useStore.getState().volume!.data;
    expect(Array.from(restoredData)).toEqual(Array.from(originalData));
    expect(useStore.getState().measurements[0].reviewStatus).toBe('confirmed');
  });

  it('到达顺序不同（两批乱序到达）最终排列一致', () => {
    const gaps = buildGappedBaseFrames(def).missingLayers;
    useStore.getState().openGappedFrames(
      buildGappedBaseFrames(def).frames,
      '缺片基底',
      { center: 120, width: 240 },
    );
    const first = buildSupplementFrames(def, { fillK: [gaps[0]], shuffle: true });
    useStore.getState().requestSupplement(first.frames);
    useStore.getState().confirmSupplement();
    const second = buildSupplementFrames(def, { fillK: [gaps[1]], shuffle: true });
    useStore.getState().requestSupplement(second.frames);
    useStore.getState().confirmSupplement();
    const dataA = Array.from(useStore.getState().volume!.data);
    const batchesA = useStore.getState().adoptedBatches.length;

    resetState();
    useStore.getState().openGappedFrames(
      buildGappedBaseFrames(def).frames,
      '缺片基底',
      { center: 120, width: 240 },
    );
    const x = buildSupplementFrames(def, { fillK: [gaps[1]], shuffle: true });
    useStore.getState().requestSupplement(x.frames);
    useStore.getState().confirmSupplement();
    const y = buildSupplementFrames(def, { fillK: [gaps[0]], shuffle: true });
    useStore.getState().requestSupplement(y.frames);
    useStore.getState().confirmSupplement();
    const dataB = Array.from(useStore.getState().volume!.data);
    expect(useStore.getState().adoptedBatches.length).toBe(batchesA);
    expect(dataA).toEqual(dataB);
  });

  it('保存重开后恢复分层采用决定、缺片与测量依据版本', () => {
    const gaps = buildGappedBaseFrames(def).missingLayers;
    useStore.getState().openGappedFrames(
      buildGappedBaseFrames(def).frames,
      '缺片基底',
      { center: 120, width: 240 },
    );
    const batch = buildSupplementFrames(def, { fillK: [gaps[0]], replaceK: [4], shuffle: true });
    useStore.getState().requestSupplement(batch.frames);
    useStore.getState().confirmSupplement();
    const batchId = useStore.getState().adoptedBatches[0].batchId;
    const beforeData = Array.from(useStore.getState().volume!.data);

    // 在替换后新增一条测量（依据版本为该批次）
    const volume = useStore.getState().volume!;
    const q1 = ijkToWorld([3, 3, 10], volume.origin, volume.direction, volume.spacing);
    const q2 = ijkToWorld([8, 8, 10], volume.origin, volume.direction, volume.spacing);
    useStore.getState().recordMeasurePoint(q1);
    useStore.getState().recordMeasurePoint(q2);

    useStore.setState({
      volume: null,
      manifest: null,
      adoptedBatches: [],
      pendingSupplement: null,
      measurements: [],
      slices: [0, 0, 0],
      cursorIJK: null,
    });
    restoreLastSession();
    const restored = useStore.getState();
    expect(restored.volume).not.toBeNull();
    expect(Array.from(restored.volume!.data)).toEqual(beforeData);
    expect(restored.manifest!.layers[gaps[0]]?.batchId).toBe(batchId);
    expect(restored.manifest!.layers[gaps[1]]).toBeNull();
    expect(restored.adoptedBatches).toHaveLength(1);
    expect(restored.measurements).toHaveLength(1);
    expect(restored.measurements[0].basisVersion).toBe(batchId);
    expect(restored.measurements[0].endpointsInRange).toBe(true);
  });
});
