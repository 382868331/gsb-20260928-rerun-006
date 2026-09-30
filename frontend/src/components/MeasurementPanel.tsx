import { useStore } from "../state/store";
import { indexToPhysicalCoord } from "../imaging/geometry";
import type { Volume } from "../types";

export function MeasurementPanel() {
  const volume = useStore((s) => s.volume);
  const measurements = useStore((s) => s.measurements);
  const remove = useStore((s) => s.removeMeasurement);
  const draft = useStore((s) => s.draft);

  if (!volume) return <aside className="panel"><h2>测量</h2><p>尚无体数据</p></aside>;

  const mine = measurements.filter((m) => m.volumeId === volume.id);
  const orphans = measurements.filter((m) => m.volumeId !== volume.id);

  return (
    <aside className="panel">
      <h2>测量结果</h2>
      {draft.length > 0 && <p className="hint">已选第 1 点，请在任一视图选择第 2 点（右键取消）</p>}
      {mine.length === 0 && <p className="hint">暂无测量。选择“距离”工具后，在两个位置各点一下即可。</p>}
      <ul className="measurement-list">
        {mine.map((m) => (
          <li key={m.id}>
            <strong>{m.label}</strong>
            {m.distanceMm !== null ? (
              <span className="value">{m.distanceMm.toFixed(2)} mm</span>
            ) : (
              <span className="value">点</span>
            )}
            <div className="coords">
              {m.points.map((p, i) => (
                <span key={i}>({p.x.toFixed(2)}, {p.y.toFixed(2)}, {p.z.toFixed(2)}) mm</span>
              ))}
            </div>
            <button onClick={() => remove(m.id)}>删除</button>
          </li>
        ))}
      </ul>
      {orphans.length > 0 && (
        <p className="warn">另有 {orphans.length} 条测量属于其他影像，未被覆盖，重新打开原影像后可见。</p>
      )}
    </aside>
  );
}

export function CursorInfo({ volume }: { volume: Volume }) {
  const cursor = useStore((s) => s.cursor);
  const p = indexToPhysicalCoord(cursor, volume);
  const v = volume.data[cursor.x + volume.dims.x * (cursor.y + volume.dims.y * cursor.z)];
  return (
    <div className="cursor-info">
      体素 [{cursor.x}, {cursor.y}, {cursor.z}] · 物理坐标 ({p.x.toFixed(2)}, {p.y.toFixed(2)}, {p.z.toFixed(2)}) mm · 灰度 {v}
    </div>
  );
}
