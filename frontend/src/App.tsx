import { useEffect } from "react";
import { SliceView } from "./components/SliceView";
import { CursorInfo, MeasurementPanel } from "./components/MeasurementPanel";
import { VIEWS } from "./imaging/mpr";
import { DEFAULT_SPEC, useStore } from "./state/store";
import { buildPhantomSeries, dropSlice, phantomOrientation } from "./imaging/phantom";
import type { ToolMode } from "./state/store";

export default function App() {
  const volume = useStore((s) => s.volume);
  const tool = useStore((s) => s.tool);
  const setTool = useStore((s) => s.setTool);
  const openPhantom = useStore((s) => s.openPhantom);
  const openSeries = useStore((s) => s.openSeries);
  const hydrate = useStore((s) => s.hydrateVolume);
  const loadErrors = useStore((s) => s.loadErrors);
  const notice = useStore((s) => s.notice);
  const clearNotice = useStore((s) => s.clearNotice);
  const cancelDraft = useStore((s) => s.cancelDraft);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  const openMissing = () => {
    const series = dropSlice(buildPhantomSeries(DEFAULT_SPEC), DEFAULT_SPEC.spacing.z * 3);
    openSeries(series, "缺片人工影像");
  };

  const openConflicting = () => {
    const base = buildPhantomSeries(DEFAULT_SPEC);
    openSeries(
      { ...base, orientation: { ...phantomOrientation(DEFAULT_SPEC), normalAxis: "y", rowAxis: "x" } },
      "方向冲突人工影像"
    );
  };

  const tools: Array<{ key: ToolMode; label: string }> = [
    { key: "distance", label: "距离测量" },
    { key: "point", label: "标记点" },
    { key: "browse", label: "仅浏览" },
  ];

  return (
    <div className="app" onContextMenu={(e) => { e.preventDefault(); cancelDraft(); }}>
      <header className="topbar">
        <h1>医学影像研究工作站</h1>
        <div className="actions">
          <button onClick={() => openPhantom(DEFAULT_SPEC)}>打开标准人工体模</button>
          <button onClick={openMissing} title="删除一层后打开，应报缺片">打开缺片影像</button>
          <button onClick={openConflicting} title="方向矩阵冲突，应拒绝">打开方向冲突影像</button>
          <span className="sep" />
          {tools.map((t) => (
            <button key={t.key} className={tool === t.key ? "active" : ""} onClick={() => setTool(t.key)}>
              {t.label}
            </button>
          ))}
        </div>
      </header>

      {notice && (
        <div className="notice" onClick={clearNotice}>
          {notice}（点击关闭）
        </div>
      )}
      {loadErrors.length > 0 && (
        <div className="errors">
          <strong>无法组成完整体数据：</strong>
          <ul>{loadErrors.map((e, i) => <li key={i}>{e}</li>)}</ul>
        </div>
      )}

      {volume && (
        <div className="volume-info">
          <span>{volume.description} · 尺寸 {volume.dims.x}×{volume.dims.y}×{volume.dims.z}
          {" "}· 间距 {volume.spacing.x}/{volume.spacing.y}/{volume.spacing.z} mm
          {" "}· 翻转 {(["x", "y", "z"] as const).filter((ax) => volume.flip[ax]).join("、") || "无"}</span>
          <CursorInfo volume={volume} />
        </div>
      )}

      <main className="layout">
        <section className="views">
          {VIEWS.map((v) => <SliceView key={v.key} view={v} />)}
        </section>
        <MeasurementPanel />
      </main>

      <footer className="footer">
        三视图十字光标联动；点击移动光标并在测量工具下记录物理坐标点；滚轮翻层。
        刷新页面（工程重开）后自动恢复浏览位置与测量结果。
      </footer>
    </div>
  );
}
