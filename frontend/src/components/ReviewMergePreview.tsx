import { useStore } from '../state/store';
import type { MergeLayerStatus } from '../core/reviewMerge';
import type { JumpKind } from '../core/consistency';

const STATUS_LABEL: Record<MergeLayerStatus, string> = {
  agreement: '决定一致',
  duplicate: '重复导入',
  'content-conflict': '同位置不同内容',
  unilateral: '仅一方补入',
  'missing-agreement': '双方均缺片',
  'geometry-conflict': '方向/尺寸/位置争议',
};

const STATUS_COLOR: Record<MergeLayerStatus, string> = {
  agreement: '#39ff7a',
  duplicate: '#9aa7b4',
  'content-conflict': '#ffd93d',
  unilateral: '#9fd0ff',
  'missing-agreement': '#ff9aa8',
  'geometry-conflict': '#ff7b7b',
};

const JUMP_LABEL: Record<JumpKind, string> = {
  'source-difference': '真实来源差异',
  'missing-slice': '缺层',
  'spatial-incompatible': '空间信息不兼容',
};

const JUMP_COLOR: Record<JumpKind, string> = {
  'source-difference': '#ffd93d',
  'missing-slice': '#ff9aa8',
  'spatial-incompatible': '#ff7b7b',
};

export function ReviewMergePreview() {
  const pending = useStore((s) => s.pendingReviewMerge);
  const setChoice = useStore((s) => s.setReviewMergeChoice);
  const confirm = useStore((s) => s.confirmReviewMerge);
  const cancel = useStore((s) => s.cancelReviewMerge);
  const runConsistencyCheck = useStore((s) => s.runConsistencyCheck);
  const proposeCandidate = useStore((s) => s.proposeConsistencyCandidate);
  const approveCandidate = useStore((s) => s.approveConsistencyCandidate);
  const dismissCandidate = useStore((s) => s.dismissConsistencyCandidate);
  if (!pending) return null;

  const counts = pending.analysis.layers.reduce((acc, layer) => {
    acc[layer.status] = (acc[layer.status] ?? 0) + 1;
    return acc;
  }, {} as Record<MergeLayerStatus, number>);

  const consistency = pending.consistency;
  const suspiciousLayers = new Set(
    (consistency?.diagnostics ?? []).filter((d) => d.suspicious).map((d) => d.layer),
  );

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="审阅合并预览">
      <div className="modal modal-wide">
        <h2>合并两份独立审阅</h2>
        <p className="hint">
          合并版是独立采集版本；来源 A/B 不会被覆盖。方向、尺寸或位置争议与同位置不同像素必须逐层显式选择，未处理层保持不确定。
          逐层决定即时保存：关闭预览或页面后重开可继续，可单独撤回某一层而不清空其他已确认层。
        </p>
        <div className="merge-summary">
          {(Object.keys(STATUS_LABEL) as MergeLayerStatus[]).map((status) => (
            <span key={status} style={{ color: STATUS_COLOR[status] }}>
              {STATUS_LABEL[status]}：{counts[status] ?? 0}
            </span>
          ))}
        </div>
        {pending.analysis.geometryErrors.length > 0 && (
          <div className="error-banner">
            {pending.analysis.geometryErrors.map((error) => <div key={error}>{error}</div>)}
          </div>
        )}
        <div className="consistency-panel">
          <div className="consistency-head">
            <h3>层间一致性辅助审阅</h3>
            <button onClick={runConsistencyCheck}>
              {consistency ? '重新计算可疑跳变区间' : '计算可疑跳变区间'}
            </button>
          </div>
          <p className="hint">
            按相邻层几何位置、掩码边界与可用像素评估，仅提示可疑区间；不会凭视觉平滑自动替换任何已确认决定。
          </p>
          {consistency && (
            <>
              {consistency.intervals.length === 0 ? (
                <p className="hint">未发现可疑跳变区间。</p>
              ) : (
                <ul className="consistency-intervals">
                  {consistency.intervals.map((interval) => (
                    <li key={`${interval.kind}-${interval.startLayer}`}>
                      <span style={{ color: JUMP_COLOR[interval.kind] }}>
                        {JUMP_LABEL[interval.kind]}
                      </span>
                      {`：第 ${interval.startLayer + 1}${interval.endLayer > interval.startLayer ? `–${interval.endLayer + 1}` : ''} 层 — `}
                      {interval.reason}
                    </li>
                  ))}
                </ul>
              )}
              {consistency.candidates.length > 0 && (
                <table className="preview-table consistency-candidates">
                  <thead>
                    <tr>
                      <th>候选调整</th>
                      <th>连续性（前 → 后）</th>
                      <th>保留原选择的代价</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {consistency.candidates.map((candidate) => (
                      <tr key={candidate.layer}>
                        <td>
                          第 {candidate.layer + 1} 层：{candidate.from?.toUpperCase() ?? '未定'} →{' '}
                          {candidate.to.toUpperCase()}
                        </td>
                        <td>
                          {candidate.continuityBefore.toFixed(3)} → {candidate.continuityAfter.toFixed(3)}
                        </td>
                        <td className="small">
                          推翻已确认决定 {candidate.costChangedDecisions} 层；影响测量{' '}
                          {candidate.costMeasurements} 条
                        </td>
                        <td>
                          <button className="active" onClick={() => approveCandidate(candidate.layer)}>
                            批准
                          </button>
                          <button onClick={() => dismissCandidate(candidate.layer)}>放弃</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </div>
        <div className="preview-table-wrap merge-table">
          <table className="preview-table">
            <thead>
              <tr>
                <th>层</th>
                <th>分类</th>
                <th>审阅 A</th>
                <th>审阅 B</th>
                <th>采用来源</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              {pending.analysis.layers.map((layer) => (
                <tr key={layer.layer} className={layer.required && !layer.selected ? 'row-unresolved' : ''}>
                  <td>第 {layer.layer + 1} 层</td>
                  <td style={{ color: STATUS_COLOR[layer.status] }}>{STATUS_LABEL[layer.status]}</td>
                  <td className="small mono">{layer.a ? `${layer.a.sourceName} · ${layer.a.hash.slice(0, 12)}` : '缺片'}</td>
                  <td className="small mono">{layer.b ? `${layer.b.sourceName} · ${layer.b.hash.slice(0, 12)}` : '缺片'}</td>
                  <td>
                    <label><input type="radio" name={`merge-${layer.layer}`} checked={layer.selected === 'a'} onChange={() => setChoice(layer.layer, 'a')} /> A</label>
                    <label><input type="radio" name={`merge-${layer.layer}`} checked={layer.selected === 'b'} onChange={() => setChoice(layer.layer, 'b')} /> B</label>
                    {layer.required && (
                      <label><input type="radio" name={`merge-${layer.layer}`} checked={!layer.selected} onChange={() => setChoice(layer.layer, null)} /> 待定</label>
                    )}
                    {consistency && suspiciousLayers.has(layer.layer) && layer.a && layer.b && (
                      <button className="small-btn" onClick={() => proposeCandidate(layer.layer)}>
                        建立候选调整
                      </button>
                    )}
                  </td>
                  <td className="small">{layer.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="modal-actions">
          <button onClick={cancel}>关闭预览（保留选择）</button>
          <button className="active" onClick={confirm} disabled={pending.analysis.unresolvedLayers.length > 0}>
            {pending.analysis.unresolvedLayers.length > 0 ? `还有 ${pending.analysis.unresolvedLayers.length} 层待定` : '生成独立合并版本'}
          </button>
        </div>
      </div>
    </div>
  );
}
