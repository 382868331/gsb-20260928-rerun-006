import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import type { IJK, ImageIdentity, Measurement } from "./types";

const META = [
  { title: "轴状 I 切片", rowAxis: 1, colAxis: 2 },
  { title: "冠状 J 切片", rowAxis: 0, colAxis: 2 },
  { title: "矢状 K 切片", rowAxis: 0, colAxis: 1 },
] as const;

interface Props {
  axis: 0 | 1 | 2;
  image: ImageIdentity;
  crosshair: IJK;
  measurements: Measurement[];
  onCrosshairChange: (point: IJK) => void;
}

export function SlicePanel({ axis, image, crosshair, measurements, onCrosshairChange }: Props) {
  const meta = META[axis];
  const index = crosshair[axis];
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [sliceVersion, setSliceVersion] = useState(0);
  const spacing = image.voxel_spacing_mm;
  const widthMm = image.shape[meta.colAxis] * spacing[meta.colAxis];
  const heightMm = image.shape[meta.rowAxis] * spacing[meta.rowAxis];
  const canvasWidth = 256;
  const canvasHeight = Math.max(96, Math.round(canvasWidth * (heightMm / widthMm)));
  const axisSign = (arrayAxis: number) => {
    const physicalAxis = image.direction_xyz_from_ijk.findIndex((row) => Math.abs(row[arrayAxis]) > 0.5);
    return Math.sign(image.direction_xyz_from_ijk[physicalAxis][arrayAxis]);
  };
  const rowSign = axisSign(meta.rowAxis);
  const colSign = axisSign(meta.colAxis);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    api
      .slice(image.image_id, axis, index)
      .then((slice) => {
        if (cancelled) return;
        const imageElement = new Image();
        imageElement.onload = () => {
          const canvas = canvasRef.current;
          if (!canvas || cancelled) return;
          const context = canvas.getContext("2d");
          if (!context) return;
          context.clearRect(0, 0, canvas.width, canvas.height);
          context.drawImage(imageElement, 0, 0, canvas.width, canvas.height);
        };
        imageElement.src = `data:image/png;base64,${slice.png_base64}`;
      })
      .catch((exc: Error) => !cancelled && setError(exc.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [image.image_id, axis, index, sliceVersion]);

  const projected = useMemo(() => {
    const project = (point: IJK) => ({
      x: (point[meta.colAxis] + 0.5) / image.shape[meta.colAxis],
      y: (point[meta.rowAxis] + 0.5) / image.shape[meta.rowAxis],
    });
    return measurements.map((measurement, measurementIndex) => ({
      measurementIndex,
      a: project(measurement.point_a_ijk),
      b: project(measurement.point_b_ijk),
    }));
  }, [measurements, image, meta]);

  const handleClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const displayX = (event.clientX - rect.left) / rect.width;
    const displayY = (event.clientY - rect.top) / rect.height;
    const x = colSign < 0 ? 1 - displayX : displayX;
    const y = rowSign < 0 ? 1 - displayY : displayY;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    const col = Math.min(image.shape[meta.colAxis] - 1, Math.floor(x * image.shape[meta.colAxis]));
    const row = Math.min(image.shape[meta.rowAxis] - 1, Math.floor(y * image.shape[meta.rowAxis]));
    const next: IJK = [...crosshair];
    next[meta.rowAxis] = row;
    next[meta.colAxis] = col;
    onCrosshairChange(next);
  };

  return (
    <section className="slice-card">
      <header>
        <h2>{meta.title}</h2>
        <span>
          {index + 1} / {image.shape[axis]}
        </span>
      </header>
      <div
        className="canvas-frame"
        style={{
          aspectRatio: `${widthMm} / ${heightMm}`,
          ["--sx" as never]: colSign,
          ["--sy" as never]: rowSign,
        }}
      >
        <div className="orientation-layer">
          <canvas
            ref={canvasRef}
            width={canvasWidth}
            height={canvasHeight}
            onClick={handleClick}
            role="img"
            aria-label={`${meta.title} ${index + 1}`}
          />
          <div
            className="crosshair crosshair-x"
            style={{ left: `${((crosshair[meta.colAxis] + 0.5) / image.shape[meta.colAxis]) * 100}%` }}
          />
          <div
            className="crosshair crosshair-y"
            style={{ top: `${((crosshair[meta.rowAxis] + 0.5) / image.shape[meta.rowAxis]) * 100}%` }}
          />
          <svg className="measurements" viewBox="0 0 1 1" preserveAspectRatio="none">
            {projected.map((item) => (
              <g key={item.measurementIndex}>
                <line x1={item.a.x} y1={item.a.y} x2={item.b.x} y2={item.b.y} />
                <circle cx={item.a.x} cy={item.a.y} r="0.018" className="point-a" />
                <circle cx={item.b.x} cy={item.b.y} r="0.018" className="point-b" />
              </g>
            ))}
          </svg>
        </div>
        {loading && <div className="overlay">加载中…</div>}
        {error && <div className="overlay error">{error}</div>}
      </div>
      <input
        aria-label={`${meta.title}索引`}
        type="range"
        min={0}
        max={image.shape[axis] - 1}
        value={index}
        onChange={(event) => {
          const next: IJK = [...crosshair];
          next[axis] = Number(event.target.value);
          onCrosshairChange(next);
        }}
      />
      <button onClick={() => setSliceVersion((value) => value + 1)}>重新取层</button>
    </section>
  )
}
