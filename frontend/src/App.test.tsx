import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, expect, it, beforeEach } from 'vitest';
import App from './App';
import { useStore } from './state/store';

describe('应用集成', () => {
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
    // 先进入空间排列预览；缺片在预览内给出具体冲突，确认按钮禁用
    expect(screen.getAllByText(/导入前空间排列预览/).length).toBeGreaterThan(0);
    expect((screen.getByText(/确认导入并替换当前数据/) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText(/缺片/).length).toBeGreaterThan(0);
    // 原视图仍在（未被错误影像覆盖）
    expect(screen.getByText('冠状 Coronal')).toBeTruthy();
    act(() => {
      fireEvent.click(screen.getByText(/关闭（保留当前数据）/));
    });
    expect(screen.queryByText(/导入前空间排列预览/)).toBeNull();
    expect(screen.getByText('冠状 Coronal')).toBeTruthy();
  });
});
