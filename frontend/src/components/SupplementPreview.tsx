import { useMemo, useState } from 'react';
import { useStore } from '../state/store';
import type { SupplementCandidate } from '../core/supplement';
import type { ImageFrame, Volume } from '../core/types';
import { extractSlice, windowLevel } from '../core/slices';

const KIND_LABEL: Record<SupplementCandidate['kind'], string> = {
  fill: '新增位置（补缺片）',
  replace: '替换片（内容不同）',
  duplicate: '重复位置（内容相同）',
  conflict: '冲突（方向/尺寸）',
};

const KIND_COLOR: Record<SupplementCandidate['kind'], string> = {
  fill: '#39ff7a',
  replace: '#ffd93d',
  duplicate: '#9aa7b4',
  conflict: '#ff7b7b',
};

function frameThumbnail(frame: ImageFrame, window: Volume['window']) {
  const canvas = document.createElement('canvas');
  canvas.width = frame.cols;
  canvas.height = frame.rows;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  const imageData = ctx.createImageData(frame.cols, frame.rows);
  for (let i = 0; i < frame.pixelData.length; i += 1) {
    const g = windowLevel(frame.pixelData[i], window.center, window.width);
    imageData.data[i * 4] = g;
    imageData.data[i * 4 + 1] = g;
    imageData.data[i * 4 + 2] = g;
    imageData.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL();
}

function layerThumbnail(volume: Volume | null, layer: number, window: Volume['window']) {
  if (!volume || layer < 0) return null;
  const pixels = extractSlice(volume, 2, layer);
  const nU = volume.dimensions[0];
  const nV = volume.dimensions[1];
  const canvas = document.createElement('canvas');
  canvas.width = nU;
  canvas.height = nV;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const imageData = ctx.createImageData(nU, nV);
  let hasNaN = false;
  for (let i = 0; i < pixels.length; i += 1) {
    const v = pixels[i];
    if (!Number.isFinite(v)) {
      hasNaN = true;
      imageData.data[i * 4] = 40;
      imageData.data[i * 4 + 1] = 10;
      imageData.data[i * 4 + 2] = 10;
    } else {
      const g = windowLevel(v, window.center, window.width);
      imageData.data[i * 4] = g;
      imageData.data[i * 4 + 1] = g;
      imageData.data[i * 4 + 2] = g;
    }
    imageData.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(imageData, 0, 0);
  return { url: canvas.toDataURL(), missing: hasNaN };
}

export function SupplementPreview() {
  const pending = useStore((s) => s.pendingSupplement);
  const volume = useStore((s) => s.volume);
  const manifest = useStore((s) => s.manifest);
  const toggleCandidate = useStore((s) => s.toggleCandidate);
  const selectAllCandidates = useStore((s) => s.selectAllCandidates);
  const clearCandidateSelection = useStore((s) => s.clearCandidateSelection);
  const confirmSupplement = useStore((s) => s.confirmSupplement);
  const cancelSupplement = useStore((s) => s.cancelSupplement);
  const [compareLayer, setCompareLayer] = useState<number | null>(null);

  const thumbs = useMemo(() => {
    if (!pending || !volume) return new Map<number, string>();
    return new Map(
      pending.analysis.candidates.map((c) => [
        c.sourceIndex,
        frameThumbnail(c.frame, volume.window),
      ]),
    );
  }, [pending, volume]);

  if (!pending || !volume) return null;
  const { analysis, selected } = pending;
  const windowSetting = volume.window;
  const compareCandidate =
    compareLayer === null
      ? null
      : analysis.candidates.find(
          (c) => c.layer === compareLayer && (c.kind === 'replace' || c.kind === 'fill' || c.kind === 'duplicate'),
        ) ?? null;
  const beforeThumb = compareLayer === null ? null : layerThumbnail(volume, compareLayer, windowSetting);
  const afterFrame = compareCandidate ? compareCandidate.frame : null;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="补片与替换片预览">
      <div className="modal modal-wide">
        <h2>补片 / 替换片预览（批次 {analysis.batchId.slice(-6)}）</h2>
        <p className="hint">
          共 {analysis.candidates.length} 张 · 基础层间距 {analysis.layerSpacing.toFixed(3)} mm ·
          当前缺片层 {analysis.missingLayers.length === 0 ? '无' : analysis.missingLayers.map((l) => l + 1).join('、')}
          {analysis.remainingMissingAfterAdopt.length > 0 && (
            <> · 采用勾选后仍缺：{analysis.remainingMissingAfterAdopt.map((l) => l + 1).join('、')}（补在其他位置不会消除缺片）</>
          )}
        </p>

        <div className="candidate-controls">
          <button onClick={selectAllCandidates}>全部可选</button>
          <button onClick={clearCandidateSelection}>全部不采用</button>
          <span className="hint">已选 {selected.size} 张；冲突项不可勾选。</span>
        </div>

        <div className="preview-table-wrap">
          <table className="preview-table">
            <thead>
              <tr>
                <th>采用</th>
                <th>补片缩略图</th>
                <th>类型</th>
                <th>命中层</th>
                <th>位置 t (mm)</th>
                <th>原始来源</th>
                <th>说明</th>
                <th>前后比较</th>
              </tr>
            </thead>
            <tbody>
              {analysis.candidates.map((c) => {
                const selectable = c.kind !== 'conflict';
                const checked = selected.has(c.sourceIndex);
                return (
                  <tr key={c.sourceIndex} className={checked ? 'row-selected' : ''}>
                    <td>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!selectable}
                        onChange={() => toggleCandidate(c.sourceIndex)}
                      />
                    </td>
                    <td>
                      <img
                        src={thumbs.get(c.sourceIndex)}
                        alt={c.sourceName}
                        className="thumb"
                      />
                    </td>
                    <td style={{ color: KIND_COLOR[c.kind] }}>{KIND_LABEL[c.kind]}</td>
                    <td>{c.layer < 0 ? '—' : c.layer + 1}</td>
                    <td>{c.t.toFixed(3)}</td>
                    <td className="mono small">{c.sourceName}</td>
                    <td className="small">
                      {c.kind === 'duplicate' && '与现有切片像素完全一致'}
                      {c.issues.map((issue, i) => (
                        <div key={i} style={{ color: '#ff9aa8' }}>{issue}</div>
                      ))}
                    </td>
                    <td>
                      {c.layer >= 0 && (
                        <button onClick={() => setCompareLayer(c.layer)}>比较第 {c.layer + 1} 层</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {compareLayer !== null && (
          <div className="compare-panel">
            <h3>第 {compareLayer + 1} 层：更新前 / 补片内容 比较</h3>
            <div className="compare-images">
              <figure>
                <figcaption>现有体数据（更新前）{beforeThumb?.missing ? ' · 缺片' : ''}</figcaption>
                {beforeThumb && <img src={beforeThumb.url} className="compare-img" alt="更新前" />}
              </figure>
              <figure>
                <figcaption>补片 / 替换片{afterFrame ? '：' + afterFrame.sourceName : '（该层无勾选项）'}</figcaption>
                {afterFrame && (
                  <img
                    src={compareCandidate ? thumbs.get(compareCandidate.sourceIndex) : ''}
                    className="compare-img"
                    alt="补片内容"
                  />
                )}
              </figure>
            </div>
            <p className="hint">
              {manifest && manifest.layers[compareLayer]
                ? '该层现有内容来自采集：' + manifest.layers[compareLayer]!.batchId
                : '该层当前为缺片。'}
              {' '}替换改变可见内容后，端点落在本层的测量会进入待复核。
            </p>
            <button onClick={() => setCompareLayer(null)}>关闭比较</button>
          </div>
        )}

        <p className="hint">
          按空间位置（层号）归位：补片到达顺序不同，最终排列一致。缺片槽位始终保留，只有同位置补片才能填满。
        </p>
        <div className="modal-actions">
          <button onClick={cancelSupplement}>拒绝本批（保留原体数据）</button>
          <button
            className="active"
            onClick={confirmSupplement}
            disabled={selected.size === 0}
          >
            采用勾选的 {selected.size} 张
          </button>
        </div>
      </div>
    </div>
  );
}
