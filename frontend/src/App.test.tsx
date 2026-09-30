import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, expect, it, beforeEach } from 'vitest';
import App from './App';
import { useStore } from './state/store';

describe('应用集成', () => {
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
});
