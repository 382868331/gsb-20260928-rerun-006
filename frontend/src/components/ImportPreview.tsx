import { useStore } from '../state/store';
import type { ImportAnalysis, SlicePlacement } from '../core/importAnalysis';
import { cross, directionLabel } from '../core/geometry';

function tColor(orientation: SlicePlacement['orientation']): string {
  if (orientation === 'opposite') return '#ff7b7b';
  if (orientation === 'incompatible') return '#ffb05c';
  return '#9fd0ff';
}

function layerBar(analysis: ImportAnalysis) {
  // 上排：原始提供顺序；下排：按空间位置排序后的层序
  const items = analysis.sourceSequence.map((p) => {
    const sortedRank = analysis.placements.findIndex((q) => q.sourceIndex === p.sourceIndex);
    return { p, sortedRank };
  });
  return (
    <div className="preview-bars">
      <div className="preview-row">
        <span className="preview-row-label">导入顺序</span>
        <div className="preview-track">
          {items.map(({ p, sortedRank }) => (
            <span
              key={`src-${p.sourceIndex}`}
              className="preview-chip"
              style={{ borderColor: tColor(p.orientation) }}
              title={`${p.sourceName} · 空间位置 t=${p.t.toFixed(2)}mm · 排序后层 ${sortedRank + 1}`}
            >
              {p.sourceIndex + 1}
            </span>
          ))}
        </div>
      </div>
      <div className="preview-row">
        <span className="preview-row-label">空间顺序</span>
        <div className="preview-track">
          {analysis.placements.map((p) => (
            <span
              key={`sp-${p.sourceIndex}`}
              className="preview-chip"
              style={{ borderColor: tColor(p.orientation) }}
              title={`来源 ${p.sourceName} · t=${p.t.toFixed(2)}mm`}
            >
              {p.sourceIndex + 1}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

export function ImportPreview() {
  const pending = useStore((s) => s.pendingImport);
  const confirmImport = useStore((s) => s.confirmImport);
  const cancelImport = useStore((s) => s.cancelImport);
  if (!pending) return null;
  const { analysis, label, frames } = pending;
  const rows = analysis.placements;
  const spacingList: number[] = [];
  for (let i = 1; i < rows.length; i += 1) spacingList.push(rows[i].t - rows[i - 1].t);
  const firstPos = frames[0].imagePositionPatient;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="导入前空间排列预览">
      <div className="modal">
        <h2>导入前空间排列预览：{label}</h2>
        <p className="hint">
          共 {analysis.frameCount} 帧 · 基础层间距 {analysis.layerSpacing?.toFixed(3) ?? '—'} mm ·
          排序后层方向 {analysis.layerDirectionLabel} ·
          提供顺序方向 {analysis.sourceDirectionLabel ?? '—'}
          {analysis.reversedOrder ? ' · 整批层序翻转（合法重排）' : ''}
          {analysis.shuffled ? ' · 存在乱序帧（将按位置重排）' : ''}
        </p>

        {layerBar(analysis)}

        <div className="preview-table-wrap">
          <table className="preview-table">
            <thead>
              <tr>
                <th>层</th>
                <th>来源帧</th>
                <th>原始来源</th>
                <th>位置 t (mm)</th>
                <th>与上层间距 (mm)</th>
                <th>方向关系</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p, i) => (
                <tr key={p.sourceIndex}>
                  <td>{i + 1}</td>
                  <td>第 {p.sourceIndex + 1} 帧</td>
                  <td className="mono small">{p.sourceName}</td>
                  <td>{p.t.toFixed(3)}</td>
                  <td>{i === 0 ? '—' : spacingList[i - 1].toFixed(3)}</td>
                  <td style={{ color: tColor(p.orientation) }}>
                    {p.orientation === 'parallel'
                      ? `同向（法线 ${directionLabel(cross(frames[p.sourceIndex].imageOrientationPatient[1], frames[p.sourceIndex].imageOrientationPatient[0]))}）`
                      : p.orientation === 'opposite'
                        ? '相反方向（法线反向）'
                        : '无法对齐'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {analysis.warnings.length > 0 && (
          <div className="preview-warnings">
            <strong>排列说明（不阻止导入）：</strong>
            <ul>
              {analysis.warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          </div>
        )}

        <p className="hint">首帧位置：({firstPos.map((c: number) => c.toFixed(2)).join(', ')}) mm。确认后才会替换当前影像；取消则保留已打开的影像与测量。</p>
        <div className="modal-actions">
          <button onClick={cancelImport}>取消（保留当前数据）</button>
          <button className="active" onClick={confirmImport}>确认按上述排列导入</button>
        </div>
      </div>
    </div>
  );
}
