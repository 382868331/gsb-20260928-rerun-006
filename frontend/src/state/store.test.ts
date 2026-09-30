import { beforeEach, describe, expect, it } from 'vitest';
import { restoreLastSession, useStore } from './store';
import { PHANTOM_CATALOG, buildFaultyFrames } from '../core/phantom';
import { ijkToWorld } from '../core/geometry';

const def = PHANTOM_CATALOG[0];

beforeEach(() => {
  localStorage.clear();
  useStore.setState({
    doc: { version: 1, sessions: {}, lastDatasetId: null },
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

  it('缺片/方向冲突不会覆盖当前影像与测量', () => {
    useStore.getState().openPhantom(def);
    const volume = useStore.getState().volume!;
    const p1 = ijkToWorld([2, 3, 4], volume.origin, volume.direction, volume.spacing);
    const p2 = ijkToWorld([8, 10, 9], volume.origin, volume.direction, volume.spacing);
    useStore.getState().recordMeasurePoint(p1);
    useStore.getState().recordMeasurePoint(p2);
    expect(useStore.getState().measurements).toHaveLength(1);

    const missing = buildFaultyFrames(def, 'missing');
    useStore.getState().openFrames(missing.frames, '坏数据', { center: 1, width: 1 });
    expect(useStore.getState().loadError?.join(' ')).toContain('缺片');
    expect(useStore.getState().volume).toBe(volume);
    expect(useStore.getState().measurements).toHaveLength(1);

    const conflict = buildFaultyFrames(def, 'conflict');
    useStore.getState().openFrames(conflict.frames, '坏数据2', { center: 1, width: 1 });
    expect(useStore.getState().loadError?.join(' ')).toContain('方向');
    expect(useStore.getState().measurements).toHaveLength(1);
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

  it('点击联动：三视图切片同时跳到点击点所在切片', () => {
    useStore.getState().openPhantom(def);
    const volume = useStore.getState().volume!;
    const world = ijkToWorld([4, 7, 11], volume.origin, volume.direction, volume.spacing);
    useStore.getState().setCursorWorld(world);
    expect(useStore.getState().slices).toEqual([4, 7, 11]);
  });
});
