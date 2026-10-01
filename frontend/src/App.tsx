import { useEffect } from 'react';
import { useStore, restoreLastSession } from './state/store';
import { MprView } from './components/MprView';
import { ImportPreview } from './components/ImportPreview';
import { PatchPreview } from './components/PatchPreview';
import { SLICE_PLANES } from './core/slices';
import { PHANTOM_CATALOG, buildFaultyFrames, buildPatchBatch, type PatchMode } from './core/phantom';
import { ijkToWorld } from './core/geometry';
import { measurementRangeStatus } from './core/patch';

export default function App() {
  const volume = useStore((s) => s.volume);
  const slices = useStore((s) => s.slices);
  const measurements = useStore((s) => s.measurements);
  const measureMode = useStore((s) => s.measureMode);
  const draftPoint = useStore((s) => s.draftPoint);
  const loadError = useStore((s) => s.loadError);
  const lastUpdate = useStore((s) => s.lastUpdate);
  const openPhantom = useStore((s) => s.openPhantom);
  const requestImport = useStore((s) => s.requestImport);
  const requestPatch = useStore((s) => s.requestPatch);
  const undoPatch = useStore((s) => s.undoPatch);
  const confirmMeasurement = useStore((s) => s.confirmMeasurement);
  const toggleMeasureMode = useStore((s) => s.toggleMeasureMode);
  const cancelDraft = useStore((s) => s.cancelDraft);
  const removeMeasurement = useStore((s) => s.removeMeasurement);
  const dismissError = useStore((s) => s.dismissError);

  useEffect(() => {
    restoreLastSession();
  }, []);

  const def = PHANTOM_CATALOG[0];

  const tryFaulty = (mode: 'missing' | 'conflict' | 'shuffle' | 'mixed') => {
    const { frames } = buildFaultyFrames(def, mode);
    const modeLabel = {
      missing: '缺片',
      conflict: '方向冲突',
      shuffle: '乱序',
      mixed: '混合冲突',
    }[mode];
    requestImport(frames, `${def.label}（${modeLabel}）`, { center: 120, width: 240 });
  };

  const receivePatch = (mode: PatchMode) => {
    const { frames, label } = buildPatchBatch(def, mode);
    requestPatch(frames, `${def.label}·${label}`);
  };

  const acquisitionLabel = (id?: string) =>
    volume?.acquisitions?.find((a) => a.id === id)?.label ?? id ?? '初始采集';

  const markerWorld = volume
    ? ijkToWorld(def.markerIjk, volume.origin, volume.direction, volume.spacing)
    : null;

  return (
    <div className="app">
      <header className="toolbar">
        <h1>医学影像研究工作站</h1>
        <div className="toolbar-actions">
          {PHANTOM_CATALOG.map((p) => (
            <button key={p.key} onClick={() => openPhantom(p)}>
              打开：{p.label}
            </button>
          ))}
          <button className="danger" onClick={() => tryFaulty('missing')}>
            载入缺片序列
          </button>
          <button className="danger" onClick={() => tryFaulty('conflict')}>
            载入方向冲突序列
          </button>
          <button onClick={() => tryFaulty('shuffle')}>
            预览：乱序序列
          </button>
          <button className="danger" onClick={() => tryFaulty('mixed')}>
            载入混合冲突序列
          </button>
          <button onClick={() => receivePatch('fill')} disabled={!volume}>
            接收补片（填补缺片）
          </button>
          <button onClick={() => receivePatch('replace')} disabled={!volume}>
            接收替换片
          </button>
          <button onClick={() => receivePatch('mixed')} disabled={!volume}>
            接收混合补片包
          </button>
          {lastUpdate && (
            <button className="danger" onClick={undoPatch}>
              撤销更新
            </button>
          )}
          <button
            className={measureMode ? 'active' : ''}
            onClick={toggleMeasureMode}
            disabled={!volume}
          >
            {measureMode ? '退出测量' : '距离测量'}
          </button>
        </div>
      </header>

      {loadError && (
        <div className="error-banner">
          <strong>无法组成完整体数据，已保留当前影像与测量不变：</strong>
          <ul>
            {loadError.map((reason, i) => (
              <li key={i}>{reason}</li>
            ))}
          </ul>
          <button onClick={dismissError}>知道了</button>
        </div>
      )}

      <ImportPreview />
      <PatchPreview />

      {!volume ? (
        <div className="empty-state">
          <p>尚未打开体数据。点击上方“打开”加载带空腔、翻转层序、不等间距的人工影像。</p>
          <p className="hint">坐标基于影像方向与体素间距解释，距离单位为毫米（mm）。</p>
        </div>
      ) : (
        <main className="workspace">
          <section className="views">
            {SLICE_PLANES.map((plane) => (
              <MprView
                key={plane.axis}
                volume={volume}
                axis={plane.axis}
                slice={slices[plane.axis]}
              />
            ))}
          </section>
          <aside className="side-panel">
            <h2>{volume.label}</h2>
            <dl className="meta">
              <dt>体素数</dt>
              <dd>{volume.dimensions.join(' × ')}</dd>
              <dt>体素间距 (mm)</dt>
              <dd>{volume.spacing.map((s) => s.toFixed(2)).join(' × ')}</dd>
              <dt>数据集 ID</dt>
              <dd className="mono">{volume.id}</dd>
              <dt>标记点患者坐标</dt>
              <dd className="mono">
                {markerWorld ? `(${markerWorld.map((c) => c.toFixed(2)).join(', ')})` : '-'}
              </dd>
              {volume.importInfo && (
                <>
                  <dt>导入判定</dt>
                  <dd className="small">
                    {volume.importInfo.reversedOrder ? '整批层序翻转，已按空间位置反向重排' : '层序方向一致'}
                    {volume.importInfo.shuffled ? '；存在乱序帧，已按位置重排' : ''}
                    <br />
                    提供顺序 {volume.importInfo.sourceDirectionLabel || '—'} → 层方向 {volume.importInfo.layerDirectionLabel}
                  </dd>
                  <dt>原始来源</dt>
                  <dd className="mono small">
                    {volume.importInfo.frameCount} 帧
                    {volume.importInfo.sourceNames[0] ? `：${volume.importInfo.sourceNames[0]} …` : ''}
                  </dd>
                </>
              )}
              {volume.acquisitions && volume.acquisitions.length > 0 && (
                <>
                  <dt>采集批次</dt>
                  <dd className="small">
                    {volume.acquisitions.map((a) => (
                      <div key={a.id}>
                        {a.id} · {a.kind === 'initial' ? '初始采集' : '补片批次'} · {a.label}
                      </div>
                    ))}
                  </dd>
                </>
              )}
              {volume.sliceManifest && (
                <>
                  <dt>缺片层</dt>
                  <dd className="small">
                    {volume.sliceManifest.filter((s) => s.status === 'missing').length === 0
                      ? '无'
                      : volume.sliceManifest
                          .filter((s) => s.status === 'missing')
                          .map((s) => `第 ${s.layer + 1} 层`)
                          .join('、')}
                  </dd>
                </>
              )}
            </dl>

            {volume.sliceDecisions && volume.sliceDecisions.some((d) => d.rejected.length > 0 || d.adopted) && (
              <details className="decisions">
                <summary>切片采用决定（{volume.sliceDecisions.length}）</summary>
                <ul>
                  {volume.sliceDecisions.map((d, i) => (
                    <li key={i} className="small">
                      第 {d.layer + 1} 层：
                      {d.adopted
                        ? `采用 ${d.adopted.sourceName}（${d.adopted.acquisition}）`
                        : '仍缺片'}
                      {d.rejected.length > 0
                        ? `；拒绝 ${d.rejected.map((r) => r.sourceName).join('、')}`
                        : ''}
                    </li>
                  ))}
                </ul>
              </details>
            )}

            {measureMode && (
              <div className="measure-hint">
                {draftPoint
                  ? '已选第一点，请在任意视图点击第二点（可先滚轮切到对应层）。'
                  : '在任意视图点击第一个端点；测量为三维患者坐标直线距离。'}
                {draftPoint && <button onClick={cancelDraft}>取消</button>}
              </div>
            )}

            <h3>测量结果（{measurements.length}）</h3>
            <ul className="measure-list">
              {measurements.map((m) => (
                <li key={m.id}>
                  <div>
                    <strong>{m.distance.toFixed(3)} mm</strong>
                    {m.review === 'pending' ? (
                      <span className="badge badge-pending">待复核</span>
                    ) : (
                      <span className="badge badge-ok">已确认</span>
                    )}
                    {(() => {
                      const status = measurementRangeStatus(volume, m);
                      if (status === 'out-of-range') {
                        return <span className="badge badge-out">超出有效范围</span>;
                      }
                      if (status === 'on-missing') {
                        return <span className="badge badge-out">位于缺片层</span>;
                      }
                      return <span className="badge badge-ok">在有效范围内</span>;
                    })()}
                    <div className="mono small">
                      ({m.p1.map((c) => c.toFixed(1)).join(', ')}) →
                      ({m.p2.map((c) => c.toFixed(1)).join(', ')})
                    </div>
                    <div className="small">依据采集：{acquisitionLabel(m.basisAcquisition)}</div>
                  </div>
                  <div className="measure-actions">
                    {m.review === 'pending' && (
                      <button onClick={() => confirmMeasurement(m.id)}>复核确认</button>
                    )}
                    <button onClick={() => removeMeasurement(m.id)}>删除</button>
                  </div>
                </li>
              ))}
            </ul>
            <p className="hint">浏览位置与测量自动保存；重开工程后恢复到原切片与定位点。</p>
          </aside>
        </main>
      )}
    </div>
  );
}
