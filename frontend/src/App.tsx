import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { SlicePanel } from "./SlicePanel";
import type { IJK, ImageIdentity, Measurement, SessionState } from "./types";

function centerOf(image: ImageIdentity): IJK {
  return image.shape.map((value) => Math.floor(value / 2)) as IJK;
}

export default function App() {
  const [images, setImages] = useState<ImageIdentity[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [crosshair, setCrosshair] = useState<IJK>([0, 0, 0]);
  const [pointA, setPointA] = useState<IJK | null>(null);
  const [pointB, setPointB] = useState<IJK | null>(null);
  const [measurements, setMeasurements] = useState<Measurement[]>([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [sessionId, setSessionId] = useState("default");
  const [checks, setChecks] = useState<Record<string, { accepted: boolean; message: string }>>({});

  const selected = useMemo(
    () => images.find((image) => image.image_id === selectedId) ?? null,
    [images, selectedId]
  );

  useEffect(() => {
    api.images().then((items) => {
      setImages(items);
      if (items[0]) {
        setSelectedId(items[0].image_id);
        setCrosshair(centerOf(items[0]));
      }
    }).catch((exc: Error) => setError(exc.message));
  }, []);

  useEffect(() => {
    api.invalidChecks().then(setChecks).catch(() => undefined);
  }, []);

  const adoptImage = (image: ImageIdentity) => {
    setImages((current) => {
      const others = current.filter((item) => item.image_id !== image.image_id);
      return [image, ...others];
    });
    setSelectedId(image.image_id);
    setCrosshair(centerOf(image));
    setPointA(null);
    setPointB(null);
    setMeasurements([]);
    setError("");
  };

  const measureSelectedPoints = async (a: IJK, b: IJK) => {
    if (!selected) return;
    try {
      setMessage("");
      const result = await api.measure(selected.image_id, a, b);
      const measurement: Measurement = {
        ...result,
        id: crypto.randomUUID(),
        label: `空间距离 ${measurements.length + 1}`,
      };
      setMeasurements((current) => [...current, measurement]);
      setMessage(`距离 ${measurement.distance_mm.toFixed(3)} mm`);
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "测距失败");
    }
  };

  const stateForSaving: SessionState = { crosshair, measurements };

  const saveSession = async () => {
    if (!selected) return;
    try {
      await api.saveSession(sessionId, selected.image_id, stateForSaving);
      setMessage(`已保存会话 ${sessionId}`);
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "保存失败");
    }
  };

  const loadSession = async () => {
    try {
      const document = await api.loadSession(sessionId);
      const available = await api.images();
      const image = available.find((item) => item.image_id === document.image_id);
      if (!image) throw new Error("会话引用的影像身份不存在");
      setImages(available);
      setSelectedId(document.image_id);
      setCrosshair(document.state.crosshair);
      setMeasurements(document.state.measurements);
      setPointA(null);
      setPointB(null);
      setMessage(`已恢复会话 ${sessionId}`);
      setError("");
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "恢复失败");
    }
  };

  const uploadArchive = async (file: File) => {
    try {
      adoptImage(await api.importZip(file));
      setMessage("ZIP 影像组导入成功");
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "导入失败");
    }
  };

  return (
    <main>
      <header className="topbar">
        <div>
          <p className="eyebrow">Synthetic-only research workspace</p>
          <h1>医学影像研究工作站</h1>
        </div>
        <div className="actions">
          <button onClick={() => api.importSample().then(adoptImage).catch((exc: Error) => setError(exc.message))}>
            导入内置翻转模体
          </button>
          <label className="upload">
            导入 ZIP
            <input
              type="file"
              accept=".zip"
              onChange={(event) => event.target.files?.[0] && void uploadArchive(event.target.files[0])}
            />
          </label>
        </div>
      </header>

      {(message || error) && (
        <div className={`notice ${error ? "bad" : "good"}`} onClick={() => { setMessage(""); setError(""); }}>
          {error || message}
        </div>
      )}

      <section className="identity-panel">
        <label>
          当前影像身份
          <select
            value={selectedId}
            onChange={(event) => {
              const image = images.find((item) => item.image_id === event.target.value);
              if (image) {
                setSelectedId(image.image_id);
                setCrosshair(centerOf(image));
                setPointA(null);
                setPointB(null);
                setMeasurements([]);
              }
            }}
          >
            {images.map((image) => <option key={image.image_id} value={image.image_id}>{image.name}</option>)}
          </select>
        </label>
        {selected && (
          <div className="identity-grid">
            <span>ID: {selected.image_id}</span>
            <span>I×J×K: {selected.shape.join(" × ")}</span>
            <span>间距 mm: {selected.voxel_spacing_mm.map((v) => v.toFixed(1)).join(" / ")}</span>
            <span>无诊断结论</span>
          </div>
        )}
      </section>

      {!selected && <section className="empty">尚未导入影像。请导入内置人工模体。</section>}

      {selected && (
        <>
          <section className="viewer-grid">
            {([0, 1, 2] as const).map((axis) => (
              <SlicePanel
                key={axis}
                axis={axis}
                image={selected}
                crosshair={crosshair}
                measurements={measurements}
                onCrosshairChange={setCrosshair}
              />
            ))}
          </section>

          <section className="work-panel">
            <div>
              <h2>联动位置与空间测量</h2>
              <p>共同位置 IJK: ({crosshair.join(", ")})</p>
              <div className="point-actions">
                <button onClick={() => setPointA(crosshair)}>设为 A 点</button>
                <button onClick={() => setPointB(crosshair)}>设为 B 点</button>
                <button
                  disabled={!pointA || !pointB}
                  onClick={() => pointA && pointB && void measureSelectedPoints(pointA, pointB)}
                >
                  计算物理距离
                </button>
              </div>
              <p className="hint">A: {pointA ? pointA.join(", ") : "未设置"}；B: {pointB ? pointB.join(", ") : "未设置"}</p>
            </div>
            <div>
              <h2>会话</h2>
              <div className="session-row">
                <input value={sessionId} onChange={(event) => setSessionId(event.target.value)} />
                <button onClick={() => void saveSession()}>保存</button>
                <button onClick={() => void loadSession()}>重新打开恢复</button>
              </div>
              <p className="hint">保存当前三视图位置和全部测量，影像身份同时校验。</p>
            </div>
          </section>

          <section className="measurement-table">
            <h2>测量记录</h2>
            {measurements.length === 0 ? <p className="hint">暂无测量。</p> : (
              <table>
                <thead><tr><th>名称</th><th>A IJK</th><th>B IJK</th><th>距离 mm</th><th></th></tr></thead>
                <tbody>
                  {measurements.map((item) => (
                    <tr key={item.id}>
                      <td>{item.label}</td>
                      <td>{item.point_a_ijk.join(", ")}</td>
                      <td>{item.point_b_ijk.join(", ")}</td>
                      <td>{item.distance_mm.toFixed(3)}</td>
                      <td><button onClick={() => setMeasurements((current) => current.filter((m) => m.id !== item.id))}>删除</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}

      <section className="validation">
        <h2>异常样本拼装校验</h2>
        {Object.entries(checks).length === 0 ? <p className="hint">检查中…</p> : Object.entries(checks).map(([key, value]) => (
          <p key={key} className={value.accepted ? "bad" : "good"}>{key}: {value.message}</p>
        ))}
      </section>
    </main>
  );
}
