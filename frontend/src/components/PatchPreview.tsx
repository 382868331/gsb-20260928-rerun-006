import { useEffect, useMemo, useRef } from 'react';
import { useStore } from '../state/store';
import { applyPatch, measurementAffectedByLayers, type PatchAssessment } from '../core/patch';
import { windowLevel } from '../core/slices';
import type { Volume } from '../core/types';

const KIND_LABEL: Record<PatchAssessment['kind'], string> = {
  'fill-missing': '补片（填补缺片）',
  extend: '新增位置（扩展范围）',
  replacement: '重复位置（替换候选）',
  'off-grid': '位置冲突（不在栅格）',
  conflict: '方向/尺寸冲突',
};

function kindColor(kind: PatchAssessment['kind']): string {
  switch (kind) {
    case 'fill-missing': return '#39ff7a';
    case 'extend': return '#9fd0ff';
    case 'replacement': return '#ffd93d';
    default: return '#ff7b7b';
  }
}

// 小灰度图：用于更新前后截面比较
function MiniSlice({ pixels, cols, rows, window, label }: {
  pixels: ArrayLike<number>;
  cols: number;
  rows: number;
  window: { center: number; width: number };
  label: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const imageData = ctx.createImageData(cols, rows);
    for (let i = 0; i < cols * rows; i += 1) {
      const v = pixels[i];
      const g = Number.isFinite(v) ? windowLevel(v, window.center, window.width) : 0;
      imageData.data[i * 4] = g;
      imageData.data[i * 4 + 1] = g;
      imageData.data[i * 4 + 2] = g;
      imageData.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(imageData, 0, 0);
  }, [pixels, cols, rows, window]);
  return (
    <div className="mini-slice">
      <canvas ref={ref} width={cols} height={rows} />
      <span>{label}</span>
    </div>
  );
}

function currentLayerPixels(volume: Volume, layer: number): ArrayLike<number> {
  const [nx, ny] = [volume.dimensions[0], volume.dimensions[1]];
  return volume.data.subarray(layer * nx * ny, (layer + 1) * nx * ny);
}

export function PatchPreview() {
  const pending = useStore((s) => s.pendingPatch);
  const volume = useStore((s) => s.volume);
  const measurements = useStore((s) => s.measurements);
  const setPatchChoice = useStore((s) => s.setPatchChoice);
  const confirmPatch = useStore((s) => s.confirmPatch);
  const cancelPatch = useStore((s) => s.cancelPatch);

  // 纯函数模拟：按当前采用勾选预演更新结果，用于测量影响与缺片变化预览
  const simulation = useMemo(() => {
    if (!pending || !volume) return null;
    try {
      return applyPatch(volume, pending.frames, pending.analysis, pending.choices, pending.label);
    } catch {
      return null;
    }
  }, [pending, volume]);

  if (!pending || !volume) return null;
  const { analysis, label, frames, choices } = pending;
  const [nx, ny] = [volume.dimensions[0], volume.dimensions[1]];

  const affected = simulation
    ? measurements.filter((m) =>
        m.review !== 'pending' &&
        measurementAffectedByLayers(simulation.volume, m, simulation.changedLayers))
    : [];
  const remainingMissing = simulation
    ? simulation.volume.sliceManifest?.filter((s) => s.status === 'missing').length ?? 0
    : 0;
  const adoptCount = analysis.assessments.filter((a) => a.adoptable && choices[a.sourceIndex]).length;
  const acquisitionLabel = (id?: string) =>
    volume.acquisitions?.find((a) => a.id === id)?.label ?? id ?? '初始采集';

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="补片与替换片预览">
      <div className="modal">
        <h2>补片/替换片预览：{label}</h2>
        <p className="hint">
          当前体数据 {volume.dimensions[2]} 层 · 层间距 {analysis.spacing.toFixed(3)} mm ·
          仍缺片 {analysis.missingBefore.length} 层
          {analysis.missingBefore.length > 0
            ? `（层 ${analysis.missingBefore.map((k) => k + 1).join('、')}）`
            : ''}
          。本批 {analysis.assessments.length} 帧，可采用 {analysis.adoptableCount} 帧；
          最终排列只取决于空间位置，与补片到达顺序无关。
        </p>

        <div className="preview-table-wrap">
          <table className="preview-table">
            <thead>
              <tr>
                <th>采用</th>
                <th>来源帧</th>
                <th>位置 t (mm)</th>
                <th>分类</th>
                <th>目标层</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              {analysis.assessments.map((a) => (
                <tr key={a.sourceIndex}>
                  <td>
                    <input
                      type="checkbox"
                      checked={a.adoptable ? !!choices[a.sourceIndex] : false}
                      disabled={!a.adoptable}
                      onChange={(e) => setPatchChoice(a.sourceIndex, e.target.checked)}
                      aria-label={`采用 ${a.sourceName}`}
                    />
                  </td>
                  <td className="mono small">{a.sourceName}</td>
                  <td>{a.t.toFixed(3)}</td>
                  <td style={{ color: kindColor(a.kind) }}>{KIND_LABEL[a.kind]}</td>
                  <td>{a.targetLayer === null ? '—' : `第 ${a.targetLayer + 1} 层`}</td>
                  <td className="small">
                    {a.conflicts.length > 0
                      ? a.conflicts.join('；')
                      : a.kind === 'replacement'
                        ? a.differs
                          ? '与当前已采用切片内容不同，采用后相关测量将进入待复核'
                          : '与当前已采用切片内容相同'
                        : a.kind === 'fill-missing'
                          ? '正好落入缺片槽位；其它缺片位置不受影响'
                          : '沿栅格扩展体数据范围'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {analysis.assessments.some((a) => a.kind === 'replacement' && a.differs && choices[a.sourceIndex]) && (
          <div className="compare-strip">
            <strong>更新前后截面比较（替换候选）：</strong>
            <div className="compare-row">
              {analysis.assessments
                .filter((a) => a.kind === 'replacement' && a.differs && choices[a.sourceIndex])
                .map((a) => (
                  <div key={a.sourceIndex} className="compare-pair">
                    <MiniSlice
                      pixels={currentLayerPixels(volume, a.targetLayer!)}
                      cols={nx}
                      rows={ny}
                      window={volume.window}
                      label={`更新前 第 ${a.targetLayer! + 1} 层`}
                    />
                    <MiniSlice
                      pixels={frames[a.sourceIndex].pixelData}
                      cols={nx}
                      rows={ny}
                      window={volume.window}
                      label={`更新后 ${a.sourceName}`}
                    />
                  </div>
                ))}
            </div>
          </div>
        )}

        <div className="preview-warnings">
          <strong>模拟结果（确认后才生效）：</strong>
          <ul>
            <li>
              内容变化层：
              {simulation && simulation.changedLayers.length > 0
                ? simulation.changedLayers.map((k) => `第 ${k + 1} 层`).join('、')
                : '无'}
              ；更新后仍缺片 {remainingMissing} 层
              {remainingMissing > 0 ? '（缺片不会因其它位置的补片而消失）' : '（无缺片）'}
            </li>
            <li>
              测量影响：{affected.length > 0
                ? `${affected.length} 条测量将进入待复核（${affected
                    .map((m) => `${m.distance.toFixed(2)}mm · 依据 ${acquisitionLabel(m.basisAcquisition)}`)
                    .join('；')}）`
                : '无测量受影响，全部保持原确认'}
            </li>
          </ul>
        </div>

        <div className="modal-actions">
          <button onClick={cancelPatch}>拒绝更新（保留原体数据）</button>
          <button className="active" onClick={confirmPatch} disabled={adoptCount === 0}>
            确认采用所选 {adoptCount} 帧
          </button>
        </div>
      </div>
    </div>
  );
}

