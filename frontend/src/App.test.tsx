import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, expect, it, beforeEach } from 'vitest';
import App from './App';
import { useStore } from './state/store';

describe('应用集成', () => {
  beforeEach(() => {
    localStorage.clear();
    useStore.setState({
    doc: { version: 3, sessions: {}, lastDatasetId: null, imports: {} },
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
  });

  it('打开体模后出现三个联动视图，缺片序列可预览并以空缺层载入', () => {
    render(<App />);
    expect(screen.queryByText(/轴向 Axial/)).toBeNull();

    act(() => {
      fireEvent.click(screen.getByText(/打开：/));
    });
    expect(screen.getAllByText(/Axial/).length).toBeGreaterThan(0);
    expect(screen.getByText('冠状 Coronal')).toBeTruthy();
    expect(screen.getByText('矢状 Sagittal')).toBeTruthy();

    act(() => {
      fireEvent.click(screen.getByText('载入缺片序列'));
    });
    // 缺片不再阻止导入：预览中说明缺片位置，确认后以空缺层保留
    expect(screen.getByText(/导入前空间排列预览/)).toBeTruthy();
    expect(screen.getAllByText(/缺片/).length).toBeGreaterThan(0);
    act(() => {
      fireEvent.click(screen.getByText(/确认按上述排列导入/));
    });
    expect(screen.queryByText(/导入前空间排列预览/)).toBeNull();
    // 三视图在，缺片层在面板中标出
    expect(screen.getByText('冠状 Coronal')).toBeTruthy();
    expect(screen.getAllByText(/缺片/).length).toBeGreaterThan(0);
  });

  it('乱序导入先显示空间排列预览，确认后才替换；混合冲突逐条说明且不替换', () => {
    render(<App />);
    act(() => {
      fireEvent.click(screen.getByText(/打开：/));
    });
    expect(screen.getAllByText(/空腔·翻转层序·不等间距/).length).toBeGreaterThan(0);

    act(() => {
      fireEvent.click(screen.getByText('预览：乱序序列'));
    });
    expect(screen.getByText(/导入前空间排列预览/)).toBeTruthy();
    expect(screen.getAllByText(/导入顺序|空间顺序/).length).toBeGreaterThan(0);
    // 取消：原数据保留
    act(() => {
      fireEvent.click(screen.getByText(/取消（保留当前数据）/));
    });
    expect(screen.queryByText(/导入前空间排列预览/)).toBeNull();

    act(() => {
      fireEvent.click(screen.getByText('预览：乱序序列'));
    });
    act(() => {
      fireEvent.click(screen.getByText(/确认按上述排列导入/));
    });
    expect(screen.queryByText(/导入前空间排列预览/)).toBeNull();
    expect(screen.getAllByText(/已按位置重排/).length).toBeGreaterThan(0);

    act(() => {
      fireEvent.click(screen.getByText('载入混合冲突序列'));
    });
    expect(screen.queryByText(/导入前空间排列预览/)).toBeNull();
    expect(screen.getAllByText(/缺片/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/重复位置/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/方向翻转冲突/).length).toBeGreaterThan(0);
    // 已打开的导入数据仍在
    expect(screen.getByText('冠状 Coronal')).toBeTruthy();
  });

  it('补片预览逐帧列出分类，确认后缺片被填补且可撤销', () => {
    render(<App />);
    act(() => {
      fireEvent.click(screen.getByText(/打开：/));
    });
    // 先载入缺片序列
    act(() => {
      fireEvent.click(screen.getByText('载入缺片序列'));
    });
    act(() => {
      fireEvent.click(screen.getByText(/确认按上述排列导入/));
    });
    expect(screen.getAllByText(/缺片/).length).toBeGreaterThan(0);

    // 接收补片：预览中分类为“补片（填补缺片）”
    act(() => {
      fireEvent.click(screen.getByText('接收补片（填补缺片）'));
    });
    expect(screen.getByText(/补片\/替换片预览/)).toBeTruthy();
    expect(screen.getAllByText(/补片（填补缺片）/).length).toBeGreaterThan(0);
    act(() => {
      fireEvent.click(screen.getByText(/确认采用所选/));
    });
    // 缺片已填补，面板显示无缺片；出现撤销入口
    expect(screen.getByText('无')).toBeTruthy();
    act(() => {
      fireEvent.click(screen.getByText('撤销更新'));
    });
    // 撤销后缺片层恢复标示
    expect(screen.getAllByText(/缺片/).length).toBeGreaterThan(0);
  });

  it('混合补片包预览列出替换候选与冲突帧，拒绝则不改动', () => {
    render(<App />);
    act(() => {
      fireEvent.click(screen.getByText(/打开：/));
    });
    act(() => {
      fireEvent.click(screen.getByText('接收混合补片包'));
    });
    expect(screen.getByText(/补片\/替换片预览/)).toBeTruthy();
    expect(screen.getAllByText(/重复位置（替换候选）/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/方向\/尺寸冲突/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/位置冲突（不在栅格）/).length).toBeGreaterThan(0);
    act(() => {
      fireEvent.click(screen.getByText(/拒绝更新（保留原体数据）/));
    });
    expect(screen.queryByText(/补片\/替换片预览/)).toBeNull();
    expect(screen.getByText('冠状 Coronal')).toBeTruthy();
  });
});
