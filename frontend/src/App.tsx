import { useEffect } from 'react';
import { useStore, restoreLastSession } from './state/store';
import { MprView } from './components/MprView';
import { SLICE_PLANES } from './core/slices';
import { PHANTOM_CATALOG, buildFaultyFrames } from './core/phantom';
import { ijkToWorld } from './core/geometry';

export default function App() {
  const volume = useStore((s) => s.volume);
  const slices = useStore((s) => s.slices);
  const measurements = useStore((s) => s.measurements);
  const measureMode = useStore((s) => s.measureMode);
  const draftPoint = useStore((s) => s.draftPoint);
  const loadError = useStore((s) => s.loadError);
  const openPhantom = useStore((s) => s.openPhantom);
  const openFrames = useStore((s) => s.openFrames);
  const toggleMeasureMode = useStore((s) => s.toggleMeasureMode);
  const cancelDraft = useStore((s) => s.cancelDraft);
  const removeMeasurement = useStore((s) => s.removeMeasurement);
  const dismissError = useStore((s) => s.dismissError);

  useEffect(() => {
    restoreLastSession();
  }, []);

  const def = PHANTOM_CATALOG[0];

  const tryFaulty = (mode: 'missing' | 'conflict') => {
    const { frames } = buildFaultyFrames(def, mode);
    openFrames(frames, `${def.label}（${mode === 'missing' ? '缺片' : '方向冲突'}）`, { center: 120, width: 240 });
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
                <li key={m.id}>
                  <div>
                    <strong>{m.distance.toFixed(3)} mm</strong>
                    <div className="mono small">
                      ({m.p1.map((c) => c.toFixed(1)).join(', ')}) →
                      ({m.p2.map((c) => c.toFixed(1)).join(', ')})
                    </div>
                  </div>
                  <button onClick={() => removeMeasurement(m.id)}>删除</button>
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
