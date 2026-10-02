import { useMemo } from 'react';
import { useStore } from '../state/store';
import { mergeReviews, previewReviewMerge } from '../core/reviewMerge';

const STATUS_LABEL = {
  'identical-adopted': '决定一致',
  'same-missing': '双方缺片',
  'same-content-duplicate': '相同内容重复导入',
  'only-a': '仅 A 覆盖',
  'only-b': '仅 B 覆盖',
  'content-conflict': '同位置不同像素',
  'geometry-conflict': '方向/尺寸/位置争议',
  'a-missing-b-adopted': 'A 缺片 / B 补入',
  'b-missing-a-adopted': 'B 缺片 / A 补入',
} as const;

export function MergePreview() {
  const pending = useStore((s) => s.pendingMerge);
  const setMergeResolution = useStore((s) => s.setMergeResolution);
  const confirmMergeReviews = useStore((s) => s.confirmMergeReviews);
  const cancelMerge = useStore((s) => s.cancelMerge);

  const analysis = useMemo(
    () => pending ? previewReviewMerge(pending.branchA.volume, pending.branchB.volume, pending.resolutions) : null,
    [pending],
  );
  const simulation = useMemo(() => {
    if (!pending || !analysis || analysis.unresolvedLayers.length > 0) return null;
    return mergeReviews(pending.branchA, pending.branchB, { resolutions: pending.resolutions });
  }, [pending, analysis]);

  if (!pending || !analysis) return null;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="双审阅合并预览">
      <div className="modal">
        <h2>合并两份独立审阅</h2>
        <p className="hint">
          {pending.branchA.label} 与 {pending.branchB.label} 来自同一采集版本。
          同位置不同像素、方向/尺寸/位置争议必须显式选择；导入顺序不会决定胜者。
        </p>
        <div className="preview-table-wrap">
          <table className="preview-table">
            <thead>
              <tr><th>层</th><th>类型</th><th>A</th><th>B</th><th>采用</th><th>说明</th></tr>
            </thead>
            <tbody>
              {analysis.items.map((item) => (
                <tr key={item.layer}>
                  <td>{item.layer + 1}</td>
                  <td style={{ color: item.conflicting ? '#ff7b7b' : '#9fe8b0' }}>
                    {STATUS_LABEL[item.status]}
                  </td>
                  <td className="small mono">{item.a?.sourceName ?? '—'}</td>
                  <td className="small mono">{item.b?.sourceName ?? '—'}</td>
                  <td>
                    {item.conflicting ? (
                      <>
                        <label>
                          <input
                            type="radio"
                            name={`merge-${item.layer}`}
                            checked={pending.resolutions[item.layer] === 'a'}
                            onChange={() => setMergeResolution(item.layer, 'a')}
                          /> A
                        </label>
                        <label>
                          <input
                            type="radio"
                            name={`merge-${item.layer}`}
                            checked={pending.resolutions[item.layer] === 'b'}
                            onChange={() => setMergeResolution(item.layer, 'b')}
                          /> B
                        </label>
                      </>
                    ) : item.resolution ? item.resolution.toUpperCase() : '缺片'}
                  </td>
                  <td className="small">{item.reasons.join('；')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="preview-warnings">
          未处理冲突：{analysis.unresolvedLayers.length ? analysis.unresolvedLayers.map((k) => `第 ${k + 1} 层`).join('、') : '无'}。
          {simulation && (
            <>
              {' '}沿用测量 {simulation.measurements.filter((m) => m.review === 'confirmed').length} 条；
              需复核 {simulation.measurements.filter((m) => m.review === 'pending').length} 条。
            </>
          )}
        </div>
        <div className="modal-actions">
          <button onClick={cancelMerge}>取消</button>
          <button
            className="active"
            disabled={analysis.unresolvedLayers.length > 0}
            onClick={() => confirmMergeReviews()}
          >
            确认合并
          </button>
        </div>
      </div>
    </div>
  );
}
