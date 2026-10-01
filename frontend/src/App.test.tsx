import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, expect, it, beforeEach } from 'vitest';
import App from './App';
import { useStore } from './state/store';

describe('应用集成', () => {
  beforeEach(() => {
    localStorage.clear();
    useStore.setState({
      doc: { version: 1, sessions: {}, lastDatasetId: null, imports: {} },
      volume: null,
      loadError: null,
      slices: [0, 0, 0],
      cursorIJK: null,
      measurements: [],
      draftPoint: null,
      measureMode: false,
    });
  });

  it('打开体模后出现三个联动视图，缺片载入给出原因且视图不消失', () => {
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
    expect(screen.getAllByText(/无法组成完整体数据/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/缺片/).length).toBeGreaterThan(0);
    // 原视图仍在（未被错误影像覆盖）
    expect(screen.getByText('冠状 Coronal')).toBeTruthy();
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

  it('缺片基底接收补片：预览新增/替换/重复/冲突，确认后测量进入待复核并可撤销', () => {
    render(<App />);
    act(() => {
      fireEvent.click(screen.getByText('打开缺片基底（补片流程）'));
    });
    expect(screen.getByText(/分层采用/)).toBeTruthy();

    act(() => {
      fireEvent.click(screen.getByText('接收混合补片批'));
    });
    expect(screen.getByText(/补片 \/ 替换片预览/)).toBeTruthy();
    expect(screen.getAllByText(/新增位置/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/替换片/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/重复位置/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/冲突/).length).toBeGreaterThan(0);

    // 打开前后截面比较
    act(() => {
      fireEvent.click(screen.getAllByText(/比较第/)[0]);
    });
    expect(screen.getByText(/更新前 \/ 补片内容/)).toBeTruthy();

    act(() => {
      fireEvent.click(screen.getByText(/采用勾选的/));
    });
    expect(screen.queryByText(/补片 \/ 替换片预览/)).toBeNull();

    // 撤销回到原数据
    act(() => {
      fireEvent.click(screen.getByText(/撤销上一批/));
    });
    expect(screen.getByText(/已应用补丁批次 0 个/)).toBeTruthy();
  });
});
