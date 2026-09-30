import { useStore } from '../state/store';
import type { FrameLayoutEntry } from '../core/series';

const ORDER_TEXT: Record<string, string> = {
  ascending: '输入顺序与空间顺序一致（头→尾排列）',
  descending: '整批为反向层序（方向一致的整体翻转，合法）',
  shuffled: '输入顺序乱序，确认后按患者坐标重新排序',
};

const ORIENTATION_TEXT: Record<string, string> = {
  consistent: '一致',
  opposite: '方向相反',
  'mirror-col': '列镜像',
  'mirror-row': '行镜像',
  inconsistent: '不共栅格',
};

function orientationClass(kind: FrameLayoutEntry['orientation']): string {
  return kind === 'consistent' ? 'ok' : 'bad';
}

export function ImportPreview() {
  const draft = useStore((s) => s.importDraft);
  const confirmImport = useStore((s) => s.confirmImport);
  const cancelImport = useStore((s) => s.cancelImport);
  if (!draft) return null;

  const { layout, sourceName } = draft;
  const errors = layout.issues.filter((i) => i.severity === 'error');
  const infos = layout.issues.filter((i) => i.severity === 'info');
  const canImport = errors.length === 0;
  const sorted = layout.entries;
  const tMin = sorted[0]?.t ?? 0;
  const tMax = sorted[sorted.length - 1]?.t ?? 0;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="导入前空间排列预览">
      <div className="modal">
        <h2>导入前空间排列预览</h2>
        <p className="modal-source">来源：<strong>{sourceName}</strong> · 共 {layout.judgment.frameCount} 帧</p>

        <section className="preview-summary">
          <div>
            <span className="summary-label">切片轴方向</span>
            <span className="mono">{layout.layerAxisLabel}</span>
          </div>
          <div>
            <span className="summary-label">面内方位（列/行）</span>
            <span className="mono">{layout.planeLabels.join(' / ')}</span>
          </div>
          <div>
            <span className="summary-label">基础层间距</span>
            <span className="mono">{layout.layerSpacing !== null ? `${layout.layerSpacing.toFixed(3)} mm` : '无法确定'}</span>
          </div>
          <div>
            <span className="summary-label">空间跨度</span>
            <span className="mono">{(tMax - tMin).toFixed(3)} mm（{tMin.toFixed(2)} → {tMax.toFixed(2)}）</span>
          </div>
          <div>
            <span className="summary-label">顺序判断</span>
            <span>{ORDER_TEXT[layout.judgment.inputOrdering]}</span>
          </div>
        </section>

        <section className="preview-rail">
          <h3>切片顺序 / 间距 / 方向（已按患者坐标空间位置排列）</h3>
          <div className="slice-rail">
            {sorted.map((e, layer) => {
              const prev = layer > 0 ? sorted[layer - 1] : null;
              const gap = prev ? e.t - prev.t : 0;
              const gapBad = prev && layout.layerSpacing !== null &&
                Math.abs(gap / layout.layerSpacing - Math.round(gap / layout.layerSpacing)) > 1e-3;
              return (
                <div className="slice-cell" key={e.index}>
                  <span className="slice-layer">#{layer}</span>
                  <span className="slice-input">输入帧 {e.index}</span>
                  <span className="slice-t mono">t={e.t.toFixed(2)}</span>
                  {prev && (
                    <span className={gapBad ? 'slice-gap bad' : 'slice-gap'}>Δ{gap.toFixed(2)}</span>
                  )}
                  <span className={`slice-orient ${orientationClass(e.orientation)}`}>
                    {ORIENTATION_TEXT[e.orientation]}
                  </span>
                </div>
              );
            })}
          </div>
        </section>

        {infos.length > 0 && (
          <section className="preview-issues info">
            <h3>排列说明（不影响组卷）</h3>
            <ul>{infos.map((i, n) => <li key={n}>{i.message}</li>)}</ul>
          </section>
        )}

        {errors.length > 0 ? (
          <section className="preview-issues error">
            <h3>无法组成一致体数据（{errors.length} 项冲突，已分别说明）</h3>
            <ul>{errors.map((i, n) => <li key={n}>{i.message}</li>)}</ul>
            <p className="hint">不会翻转任何切片，也不会替换当前影像与测量。</p>
          </section>
        ) : (
          <section className="preview-issues ok-note">
            <h3>校验通过</h3>
            <p>各切片方向一致、位置连续、间距合规。确认后将{layout.judgment.reordered ? '按空间位置重排并' : ''}替换当前数据；重排不改变任何空间测量结果。</p>
          </section>
        )}

        <div className="modal-actions">
          <button onClick={cancelImport}>{canImport ? '取消（保留当前数据）' : '关闭（保留当前数据）'}</button>
          <button className="primary" onClick={confirmImport} disabled={!canImport}>
            确认导入并替换当前数据
          </button>
        </div>
      </div>
    </div>
  );
}
