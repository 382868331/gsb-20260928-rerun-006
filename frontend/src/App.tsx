import { useEffect } from 'react';
import { useStore, restoreLastSession } from './state/store';
import { MprView } from './components/MprView';
import { ImportPreview } from './components/ImportPreview';
import { SupplementPreview } from './components/SupplementPreview';
import { SLICE_PLANES } from './core/slices';
import { PHANTOM_CATALOG, buildFaultyFrames, buildGappedBaseFrames, buildSupplementFrames } from './core/phantom';
import { ijkToWorld } from './core/geometry';

export default function App() {
  const volume = useStore((s) => s.volume);
  const slices = useStore((s) => s.slices);
  const measurements = useStore((s) => s.measurements);
  const measureMode = useStore((s) => s.measureMode);
  const draftPoint = useStore((s) => s.draftPoint);
  const loadError = useStore((s) => s.loadError);
  const openPhantom = useStore((s) => s.openPhantom);
  const requestImport = useStore((s) => s.requestImport);
  const toggleMeasureMode = useStore((s) => s.toggleMeasureMode);
  const cancelDraft = useStore((s) => s.cancelDraft);
  const removeMeasurement = useStore((s) => s.removeMeasurement);
  const dismissError = useStore((s) => s.dismissError);
  const openGappedFrames = useStore((s) => s.openGappedFrames);
  const requestSupplement = useStore((s) => s.requestSupplement);
  const undoLastBatch = useStore((s) => s.undoLastBatch);
  const reconfirmMeasurement = useStore((s) => s.reconfirmMeasurement);
  const manifest = useStore((s) => s.manifest);
  const adoptedBatches = useStore((s) => s.adoptedBatches);

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

  // 打开一个带缺片的基底（同一体模，抽掉中间两层），随后可接收补片
  const openGapped = () => {
    const { frames } = buildGappedBaseFrames(def);
    openGappedFrames(frames, def.label + '（缺片基底）', { center: 120, width: 240 });
  };

  // 同一批采集：补一张缺片 + 替换一张现有层 + 一张重复 + 一个方向/尺寸冲突
  const receiveMixedBatch = () => {
    const gaps = buildGappedBaseFrames(def).missingLayers;
    const batch = buildSupplementFrames(def, {
      fillK: [gaps[0]],
      replaceK: [4],
      duplicateK: [10],
      sizeConflictK: 6,
      orientationConflictK: 8,
      shuffle: true,
    });
    requestSupplement(batch.frames);
  };

  // 仅补另一张缺片（补的是另一个位置，第一张缺片不应消失）
  const receiveFillOther = () => {
    const gaps = buildGappedBaseFrames(def).missingLayers;
    const batch = buildSupplementFrames(def, { fillK: [gaps[1]], shuffle: true });
    requestSupplement(batch.frames);
  };

  // 同批补片分两次、不同到达顺序到达，最终排列应一致
  const receiveFillFirst = () => {
    const gaps = buildGappedBaseFrames(def).missingLayers;
    const batch = buildSupplementFrames(def, { fillK: [gaps[0]], shuffle: false });
    requestSupplement(batch.frames);
  };

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
          <button onClick={openGapped}>
            打开缺片基底（补片流程）
          </button>
          <button onClick={receiveMixedBatch} disabled={!manifest}>
            接收混合补片批
          </button>
          <button onClick={receiveFillOther} disabled={!manifest}>
            接收另一位置补片
          </button>
          <button onClick={receiveFillFirst} disabled={!manifest}>
            接收缺片补片
          </button>
          <button onClick={undoLastBatch} disabled={adoptedBatches.length === 0}>
            撤销上一批（{adoptedBatches.length}）
          </button>
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
      <SupplementPreview />

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
            </dl>

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
                <li key={m.id} className={m.reviewStatus === 'review' ? 'measure-review' : ''}>
                  <div>
                    <strong>{m.distance.toFixed(3)} mm</strong>
                    {m.reviewStatus === 'review' && (
                      <span className="badge badge-review">待复核</span>
                    )}
                    {m.endpointsInRange === false && (
                      <span className="badge badge-out">超出有效影像范围</span>
                    )}
                    <div className="mono small">
                      ({m.p1.map((c) => c.toFixed(1)).join(', ')}) →
                      ({m.p2.map((c) => c.toFixed(1)).join(', ')})
                    </div>
                    <div className="mono small hint">
                      依据采集：{m.basisVersion ?? 'base'} ·
                      有效性：{m.endpointsInRange === undefined ? '—' : m.endpointsInRange ? '在有效影像内' : '越界'}
                    </div>
                  </div>
                  <div className="measure-actions">
                    {m.reviewStatus === 'review' && (
                      <button onClick={() => reconfirmMeasurement(m.id)}>确认复核</button>
                    )}
                    <button onClick={() => removeMeasurement(m.id)}>删除</button>
                  </div>
                </li>
              ))}
            </ul>
            {manifest && (
              <p className="hint">
                分层采用：第 {manifest.layers.map((src, k) => (src ? null : k + 1)).filter((x) => x !== null).join('、') || '无'} 层缺片。
                已应用补丁批次 {adoptedBatches.length} 个；替换内容影响的测量进入待复核。
              </p>
            )}
            <p className="hint">浏览位置与测量自动保存；重开后恢复原切片、定位点、每张切片采用决定与测量依据的采集版本。</p>
          </aside>
        </main>
      )}
    </div>
  );
}
