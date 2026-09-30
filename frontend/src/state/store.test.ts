import { beforeEach, describe, expect, it } from 'vitest';
import { restoreLastSession, useStore } from './store';
import { PHANTOM_CATALOG, buildFaultyFrames } from '../core/phantom';
import { ijkToWorld } from '../core/geometry';

const def = PHANTOM_CATALOG[0];

beforeEach(() => {
  localStorage.clear();
    useStore.setState({
      doc: { version: 2, sessions: {}, lastDatasetId: null, lastFrameImport: null },
    volume: null,
    loadError: null,
    slices: [0, 0, 0],
    cursorIJK: null,
    measurements: [],
    draftPoint: null,
    measureMode: false,
  });
});

describe('状态与持久化', () => {
  it('打开体模后三视图切片位置正确初始化', () => {
    useStore.getState().openPhantom(def);
    const state = useStore.getState();
    expect(state.volume?.id).toBe(`phantom:${def.key}`);
    expect(state.slices).toEqual([12, 10, 8]);
  });

  const importFrames = (mode: Parameters<typeof buildFaultyFrames>[1]) => {
    const pack = buildFaultyFrames(def, mode);
    useStore.getState().previewFrames(pack.frames, pack.sourceName, pack.sourceName, { center: 1, width: 1 });
    useStore.getState().confirmImport();
  };

  it('缺片/方向冲突在确认阶段被拒，不会覆盖当前影像与测量', () => {
    useStore.getState().openPhantom(def);
    const volume = useStore.getState().volume!;
    const p1 = ijkToWorld([2, 3, 4], volume.origin, volume.direction, volume.spacing);
    const p2 = ijkToWorld([8, 10, 9], volume.origin, volume.direction, volume.spacing);
    useStore.getState().recordMeasurePoint(p1);
    useStore.getState().recordMeasurePoint(p2);
    expect(useStore.getState().measurements).toHaveLength(1);

    importFrames('missing');
    expect(useStore.getState().loadError?.join(' ')).toContain('缺片');
    expect(useStore.getState().volume).toBe(volume);
    expect(useStore.getState().measurements).toHaveLength(1);

    importFrames('conflict');
    expect(useStore.getState().loadError?.join(' ')).toContain('方向');
    expect(useStore.getState().measurements).toHaveLength(1);
  });

  it('单帧方向相反被明确拒绝，不做静默翻转', () => {
    useStore.getState().openPhantom(def);
    const volume = useStore.getState().volume!;
    importFrames('opposite');
    const reasons = useStore.getState().loadError?.join(' ') ?? '';
    expect(reasons).toContain('方向相反');
    expect(useStore.getState().volume).toBe(volume);
  });

  it('乱序批次重排后得到与正常顺序相同的体数据与空间测量', () => {
    useStore.getState().openPhantom(def);
    const original = useStore.getState().volume!;
    const p1 = ijkToWorld([2, 3, 4], original.origin, original.direction, original.spacing);
    const p2 = ijkToWorld([20, 15, 11], original.origin, original.direction, original.spacing);
    const expectedDist = (() => {
      const dx = p2[0] - p1[0], dy = p2[1] - p1[1], dz = p2[2] - p1[2];
      return Math.sqrt(dx * dx + dy * dy + dz * dz);
    })();

    // 参考：正常顺序的同一批帧组卷得到的几何 id
    const orderedPack = buildFaultyFrames(def, 'none');
    useStore.getState().previewFrames(orderedPack.frames, 'ref', 'ref', { center: 120, width: 240 });
    useStore.getState().confirmImport();
    const orderedId = useStore.getState().volume!.id;

    const shuffled = buildFaultyFrames(def, 'shuffled');
    useStore.getState().previewFrames(shuffled.frames, shuffled.sourceName, '乱序重排验证', { center: 120, width: 240 });
    const draft = useStore.getState().importDraft!;
    expect(draft.layout.judgment.inputOrdering).toBe('shuffled');
    expect(draft.layout.issues.some((i) => i.severity === 'error')).toBe(false);
    useStore.getState().confirmImport();
    const rebuilt = useStore.getState().volume!;
    expect(rebuilt.id).toBe(orderedId);
    // 重排后像素逐体素一致
    expect(Array.from(rebuilt.data)).toEqual(Array.from(original.data));
    const rp1 = ijkToWorld([2, 3, 4], rebuilt.origin, rebuilt.direction, rebuilt.spacing);
    const rp2 = ijkToWorld([20, 15, 11], rebuilt.origin, rebuilt.direction, rebuilt.spacing);
    const d = (() => { const x = rp2[0]-rp1[0], y = rp2[1]-rp1[1], z = rp2[2]-rp1[2]; return Math.sqrt(x*x+y*y+z*z); })();
    expect(d).toBeCloseTo(expectedDist, 6);
    expect(rebuilt.importInfo?.judgment.reordered).toBe(true);
  });

  it('混合批次把缺片、单帧反向、乱序分别说明', () => {
    useStore.getState().openPhantom(def);
    const volume = useStore.getState().volume!;
    const mixed = buildFaultyFrames(def, 'mixed');
    useStore.getState().previewFrames(mixed.frames, mixed.sourceName, '混合坏数据', { center: 1, width: 1 });
    const draft = useStore.getState().importDraft!;
    expect(draft.layout.judgment.inputOrdering).toBe('shuffled');
    const kinds = new Set(draft.layout.issues.map((i) => i.kind));
    expect(kinds.has('gap')).toBe(true);
    expect(kinds.has('orientation-opposite')).toBe(true);
    useStore.getState().confirmImport();
    expect(useStore.getState().volume).toBe(volume);
  });

  it('重复位置被识别为重复切片', () => {
    useStore.getState().openPhantom(def);
    importFrames('duplicate');
    expect(useStore.getState().loadError?.join(' ')).toContain('重复');
  });

  it('取消导入保留当前影像与测量', () => {
    useStore.getState().openPhantom(def);
    const volume = useStore.getState().volume!;
    const shuffled = buildFaultyFrames(def, 'shuffled');
    useStore.getState().previewFrames(shuffled.frames, shuffled.sourceName, 'x', { center: 1, width: 1 });
    expect(useStore.getState().importDraft).not.toBeNull();
    useStore.getState().cancelImport();
    expect(useStore.getState().importDraft).toBeNull();
    expect(useStore.getState().volume).toBe(volume);
  });

  it('测量距离按物理间距计算，保存的是患者坐标', () => {
    useStore.getState().openPhantom(def);
    const volume = useStore.getState().volume!;
    const p1 = ijkToWorld([0, 0, 0], volume.origin, volume.direction, volume.spacing);
    const p2 = ijkToWorld([3, 2, 4], volume.origin, volume.direction, volume.spacing);
    useStore.getState().recordMeasurePoint(p1);
    useStore.getState().recordMeasurePoint(p2);
    const m = useStore.getState().measurements[0];
    expect(m.distance).toBeCloseTo(
      Math.sqrt((3 * 1.2) ** 2 + (2 * 0.8) ** 2 + (4 * 2.5) ** 2),
      6,
    );
  });

  it('工程重开后恢复原浏览位置与测量', () => {
    useStore.getState().openPhantom(def);
    const volume = useStore.getState().volume!;
    useStore.getState().setSlice(2, 13);
    const target = ijkToWorld([18, 5, 12], volume.origin, volume.direction, volume.spacing);
    useStore.getState().setCursorWorld(target);
    const p1 = ijkToWorld([1, 1, 1], volume.origin, volume.direction, volume.spacing);
    const p2 = ijkToWorld([2, 2, 2], volume.origin, volume.direction, volume.spacing);
    useStore.getState().recordMeasurePoint(p1);
    useStore.getState().recordMeasurePoint(p2);

    // 模拟重开：清空内存状态后从 localStorage 恢复
    useStore.setState({
      volume: null,
      slices: [0, 0, 0],
      cursorIJK: null,
      measurements: [],
    });
    restoreLastSession();
    const restored = useStore.getState();
    expect(restored.volume?.id).toBe(`phantom:${def.key}`);
    expect(restored.cursorIJK).toEqual([18, 5, 12]);
    expect(restored.slices).toEqual([18, 5, 12]);
    expect(restored.measurements).toHaveLength(1);
    expect(restored.measurements[0].distance).toBeGreaterThan(0);
  });

  it('帧序列导入重开后保留原始来源、导入判断与测量', () => {
    useStore.getState().openPhantom(def);
    const shuffled = buildFaultyFrames(def, 'shuffled');
    useStore.getState().previewFrames(shuffled.frames, shuffled.sourceName, '乱序重排验证', { center: 120, width: 240 });
    useStore.getState().confirmImport();
    const imported = useStore.getState().volume!;
    const q1 = ijkToWorld([1, 1, 1], imported.origin, imported.direction, imported.spacing);
    const q2 = ijkToWorld([5, 6, 7], imported.origin, imported.direction, imported.spacing);
    useStore.getState().recordMeasurePoint(q1);
    useStore.getState().recordMeasurePoint(q2);
    expect(useStore.getState().measurements).toHaveLength(1);

    useStore.setState({ volume: null, measurements: [], slices: [0, 0, 0], cursorIJK: null });
    restoreLastSession();
    const restored = useStore.getState();
    expect(restored.volume?.id).toBe(imported.id);
    expect(restored.volume?.importInfo?.sourceName).toBe(shuffled.sourceName);
    expect(restored.volume?.importInfo?.judgment.inputOrdering).toBe('shuffled');
    expect(restored.measurements).toHaveLength(1);
  });

  it('点击联动：三视图切片同时跳到点击点所在切片', () => {
    useStore.getState().openPhantom(def);
    const volume = useStore.getState().volume!;
    const world = ijkToWorld([4, 7, 11], volume.origin, volume.direction, volume.spacing);
    useStore.getState().setCursorWorld(world);
    expect(useStore.getState().slices).toEqual([4, 7, 11]);
  });
});
