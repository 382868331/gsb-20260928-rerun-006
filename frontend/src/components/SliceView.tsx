import { useEffect, useMemo, useRef } from "react";
import type { ViewSpec } from "../imaging/mpr";
import { canvasToPhysical, physicalToCanvas, sampleSlice } from "../imaging/mpr";
import { indexToPhysicalCoord } from "../imaging/geometry";
import { useStore } from "../state/store";
import type { Volume } from "../types";

interface Props {
  view: ViewSpec;
}

const SCALE = 14;

export function SliceView({ view }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const offscreenRef = useRef<HTMLCanvasElement | null>(null);
  const volume = useStore((s) => s.volume);
  const cursor = useStore((s) => s.cursor);
  const measurements = useStore((s) => s.measurements);
  const draft = useStore((s) => s.draft);
  const tool = useStore((s) => s.tool);
  const setCursor = useStore((s) => s.setCursor);
  const addPoint = useStore((s) => s.addPoint);

  const normalIndex = volume ? cursor[view.normal] : 0;
  const slice = useMemo(
    () => (volume ? sampleSlice(volume, view, normalIndex) : null),
    [volume, view, normalIndex]
  );

  if (!volume || !slice) {
    return (
      <div className="slice-view empty">
        <h3>{view.label}</h3>
        <p>未加载体数据</p>
      </div>
    );
  }

  const cw = slice.width * SCALE;
  const ch = slice.height * SCALE;
  const cross = physicalToCanvas(volume, view, indexToPhysicalCoord(cursor, volume));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !slice) return;
    if (!offscreenRef.current) offscreenRef.current = document.createElement("canvas");
    const off = offscreenRef.current;
    off.width = slice.width;
    off.height = slice.height;
    const octx = off.getContext("2d")!;
    const range = Math.max(1, slice.max - slice.min);
    const img = octx.createImageData(slice.width, slice.height);
    for (let i = 0; i < slice.values.length; i++) {
      const g = Math.round(((slice.values[i] - slice.min) / range) * 255);
      img.data[i * 4] = g;
      img.data[i * 4 + 1] = g;
      img.data[i * 4 + 2] = g;
      img.data[i * 4 + 3] = 255;
    }
    octx.putImageData(img, 0, 0);

    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, cw, ch);
    ctx.drawImage(off, 0, 0, slice.width, slice.height, 0, 0, cw, ch);

    ctx.strokeStyle = "#ff5252";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cross.col * SCALE + SCALE / 2, 0);
    ctx.lineTo(cross.col * SCALE + SCALE / 2, ch);
    ctx.moveTo(0, cross.row * SCALE + SCALE / 2);
    ctx.lineTo(cw, cross.row * SCALE + SCALE / 2);
    ctx.stroke();

    const drawMarker = (col: number, row: number, color: string, radius = 4) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(col * SCALE + SCALE / 2, row * SCALE + SCALE / 2, radius, 0, Math.PI * 2);
      ctx.fill();
    };
    const active = measurements.filter((m) => m.volumeId === volume.id);
    for (const m of active) {
      const pts = m.points.map((p) => physicalToCanvas(volume, view, p));
      if (pts.length === 2) {
        ctx.strokeStyle = "#40c4ff";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(pts[0].col * SCALE + SCALE / 2, pts[0].row * SCALE + SCALE / 2);
        ctx.lineTo(pts[1].col * SCALE + SCALE / 2, pts[1].row * SCALE + SCALE / 2);
        ctx.stroke();
      }
      pts.forEach((pt, i) => drawMarker(pt.col, pt.row, i === 0 ? "#69f0ae" : "#ffab40"));
    }
    for (const p of draft) {
      const pt = physicalToCanvas(volume, view, p);
      drawMarker(pt.col, pt.row, "#e040fb");
    }
    drawMarker(cross.col, cross.row, "#ff5252", 3);
  }, [slice, volume, cross.col, cross.row, measurements, draft, cw, ch]);

  const eventToColRow = (ev: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = ev.currentTarget.getBoundingClientRect();
    const col = Math.floor(((ev.clientX - rect.left) / rect.width) * slice.width);
    const row = Math.floor(((ev.clientY - rect.top) / rect.height) * slice.height);
    return { col: Math.max(0, Math.min(slice.width - 1, col)), row: Math.max(0, Math.min(slice.height - 1, row)) };
  };

  const onClick = (ev: React.MouseEvent<HTMLCanvasElement>) => {
    const { col, row } = eventToColRow(ev);
    const idx = { x: 0, y: 0, z: 0 } as Record<string, number>;
    idx[view.normal] = normalIndex;
    idx[view.colAxis] = volume.flip[view.colAxis] ? volume.dims[view.colAxis] - 1 - col : col;
    idx[view.rowAxis] = volume.flip[view.rowAxis] ? volume.dims[view.rowAxis] - 1 - row : row;
    setCursor({ x: idx.x, y: idx.y, z: idx.z });
    if (tool !== "browse") {
      addPoint(canvasToPhysical(volume, view, col, row, normalIndex));
    }
  };

  const onWheel = (ev: React.WheelEvent<HTMLCanvasElement>) => {
    const delta = ev.deltaY > 0 ? 1 : -1;
    setCursor({ [view.normal]: normalIndex + delta } as Partial<{ x: number; y: number; z: number }>);
  };

  const posMm = (normalIndex - (volume.flip[view.normal] ? volume.dims[view.normal] - 1 : 0)) *
    (volume.flip[view.normal] ? -1 : 1) * volume.spacing[view.normal];

  return (
    <div className="slice-view">
      <h3>{view.label}</h3>
      <canvas
        ref={canvasRef}
        width={cw}
        height={ch}
        onClick={onClick}
        onWheel={onWheel}
        style={{ cursor: tool === "browse" ? "crosshair" : "cell" }}
      />
      <div className="slice-meta">
        层 {normalIndex + 1}/{volume.dims[view.normal]} · {view.normal} = {posMm.toFixed(2)} mm
        （滚轮翻层）
      </div>
    </div>
  );
}
