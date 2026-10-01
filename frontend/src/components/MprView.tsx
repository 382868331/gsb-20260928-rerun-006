import { useEffect, useRef } from 'react';
import type { Axis } from '../core/slices';
import { extractSlice, planeAxes, planeToWorld, windowLevel } from '../core/slices';
import type { Volume } from '../core/types';
import {
  mat3Column,
  worldToIjk,
  directionLabel,
  oppositeLabel,
} from '../core/geometry';
import { useStore } from '../state/store';

interface MprViewProps {
  volume: Volume;
  axis: Axis;
  slice: number;
}

const PADDING = 26;

export function MprView({ volume, axis, slice }: MprViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cursorIJK = useStore((s) => s.cursorIJK);
  const measurements = useStore((s) => s.measurements);
  const measureMode = useStore((s) => s.measureMode);
  const draftPoint = useStore((s) => s.draftPoint);
  const setSlice = useStore((s) => s.setSlice);
  const setCursorWorld = useStore((s) => s.setCursorWorld);
  const recordMeasurePoint = useStore((s) => s.recordMeasurePoint);

  const [uAxis, vAxis] = planeAxes(axis);
  const nU = volume.dimensions[uAxis];
  const nV = volume.dimensions[vAxis];
  const spacingU = volume.spacing[uAxis];
  const spacingV = volume.spacing[vAxis];

  // 物理尺寸(mm) 决定视图宽高比，绝不用体素下标当距离
  const physicalW = nU * spacingU;
  const physicalH = nV * spacingV;
  const canvasSize = 320;
  const scale = Math.min(
    (canvasSize - PADDING * 2) / physicalW,
    (canvasSize - PADDING * 2) / physicalH,
  );
  const drawW = physicalW * scale;
  const drawH = physicalH * scale;
  const offsetX = (canvasSize - drawW) / 2;
  const offsetY = (canvasSize - drawH) / 2;

  const pixelToPlane = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const px = ((clientX - rect.left) / rect.width) * canvasSize;
    const py = ((clientY - rect.top) / rect.height) * canvasSize;
    const u = Math.round((px - offsetX) / (spacingU * scale) - 0.5);
    const v = Math.round((py - offsetY) / (spacingV * scale) - 0.5);
    if (u < 0 || u >= nU || v < 0 || v >= nV) return null;
    return { u, v };
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const img = extractSlice(volume, axis, slice);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvasSize, canvasSize);

    // 离屏小图：每个体素一个灰度像素，再按物理比例放大
    const off = document.createElement('canvas');
    off.width = nU;
    off.height = nV;
    const offCtx = off.getContext('2d');
    if (offCtx) {
      const imageData = offCtx.createImageData(nU, nV);
      for (let i = 0; i < img.length; i += 1) {
        const g = Number.isFinite(img[i])
          ? windowLevel(img[i], volume.window.center, volume.window.width)
          : 0; // 缺片层体素为 NaN，渲染为黑
        imageData.data[i * 4] = g;
        imageData.data[i * 4 + 1] = g;
        imageData.data[i * 4 + 2] = g;
        imageData.data[i * 4 + 3] = 255;
      }
      offCtx.putImageData(imageData, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(off, offsetX, offsetY, drawW, drawH);
    }

    // 缺片层：明确标示该层无影像（等待补片），而非显示空白让人误以为有内容
    const slot = axis === 2 ? volume.sliceManifest?.[slice] : undefined;
    if (slot && slot.status === 'missing') {
      ctx.fillStyle = 'rgba(122, 46, 56, 0.35)';
      ctx.fillRect(offsetX, offsetY, drawW, drawH);
      ctx.strokeStyle = '#7a2e38';
      ctx.lineWidth = 1;
      for (let x = -drawH; x < drawW; x += 12) {
        ctx.beginPath();
        ctx.moveTo(offsetX + x, offsetY + drawH);
        ctx.lineTo(offsetX + x + drawH, offsetY);
        ctx.stroke();
      }
      ctx.fillStyle = '#ff9aa8';
      ctx.font = 'bold 16px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`缺片（t=${slot.t.toFixed(2)}mm，等待补片）`, canvasSize / 2, canvasSize / 2);
      ctx.textAlign = 'left';
    }

    const ijkPointOnPlane = (world: Parameters<typeof worldToIjk>[0]) => {
      const ijk = worldToIjk(world, volume.origin, volume.direction, volume.spacing);
      return {
        x: offsetX + (ijk[uAxis] + 0.5) * spacingU * scale,
        y: offsetY + (ijk[vAxis] + 0.5) * spacingV * scale,
        fixed: ijk[axis],
      };
    };

    // 十字定位线：联动点在本平面的投影
    if (cursorIJK) {
      const cx = offsetX + (cursorIJK[uAxis] + 0.5) * spacingU * scale;
      const cy = offsetY + (cursorIJK[vAxis] + 0.5) * spacingV * scale;
      const onSlice = Math.abs(cursorIJK[axis] - slice) < 0.5;
      ctx.strokeStyle = onSlice ? '#39ff7a' : '#ff9f43';
      ctx.lineWidth = 1;
      ctx.setLineDash(onSlice ? [] : [4, 3]);
      ctx.beginPath();
      ctx.moveTo(cx, offsetY);
      ctx.lineTo(cx, offsetY + drawH);
      ctx.moveTo(offsetX, cy);
      ctx.lineTo(offsetX + drawW, cy);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 测量线段（端点位于本切片时高亮）
    ctx.lineWidth = 2;
    for (const m of measurements) {
      const a = ijkPointOnPlane(m.p1);
      const b = ijkPointOnPlane(m.p2);
      const near = Math.abs(a.fixed - slice) < 0.5 && Math.abs(b.fixed - slice) < 0.5;
      ctx.strokeStyle = near ? '#ffd93d' : 'rgba(255,217,61,0.35)';
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      for (const p of [a, b]) {
        ctx.fillStyle = '#ffd93d';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
        ctx.fill();
      }
      if (near) {
        ctx.fillStyle = '#ffd93d';
        ctx.font = '12px sans-serif';
        ctx.fillText(`${m.distance.toFixed(2)} mm`, (a.x + b.x) / 2 + 6, (a.y + b.y) / 2 - 6);
      }
    }

    if (draftPoint) {
      const a = ijkPointOnPlane(draftPoint);
      ctx.fillStyle = '#ff5d8f';
      ctx.beginPath();
      ctx.arc(a.x, a.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }

    // 解剖方位标签（方向由 direction 列向量解释，翻转层序时会变成 I/A/R）
    const uDir = mat3Column(volume.direction, uAxis);
    const vDir = mat3Column(volume.direction, vAxis);
    ctx.fillStyle = '#9fd0ff';
    ctx.font = 'bold 13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(directionLabel(uDir), canvasSize - PADDING, canvasSize / 2 + 4);
    ctx.fillText(oppositeLabel(directionLabel(uDir)), PADDING, canvasSize / 2 + 4);
    ctx.fillText(directionLabel(vDir), canvasSize / 2, PADDING - 8);
    ctx.fillText(oppositeLabel(directionLabel(vDir)), canvasSize / 2, canvasSize - 8);
    ctx.textAlign = 'left';
  }, [volume, axis, slice, nU, nV, spacingU, spacingV, scale, offsetX, offsetY, drawW, drawH, cursorIJK, measurements, draftPoint, uAxis, vAxis]);

  const handleClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const plane = pixelToPlane(event.clientX, event.clientY);
    if (!plane) return;
    const world = planeToWorld(volume, axis, slice, plane.u, plane.v);
    if (measureMode) recordMeasurePoint(world);
    else setCursorWorld(world);
  };

  const handleWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    setSlice(axis, slice + (event.deltaY > 0 ? 1 : -1));
  };

  const layerSpacing = volume.spacing[axis];

  return (
    <div className="mpr-view">
      <div className="mpr-header">
        <span>{axis === 2 ? '轴向 Axial' : axis === 1 ? '冠状 Coronal' : '矢状 Sagittal'}</span>
        <span>切片 {slice + 1}/{volume.dimensions[axis]} · 位置 {(slice * layerSpacing).toFixed(2)} mm</span>
      </div>
      <canvas
        ref={canvasRef}
        width={canvasSize}
        height={canvasSize}
        onClick={handleClick}
        onWheel={handleWheel}
        className={measureMode ? 'measure' : ''}
        title="点击：联动定位；滚轮：切换切片；测量模式下点击两个端点"
      />
      <input
        type="range"
        min={0}
        max={volume.dimensions[axis] - 1}
        value={slice}
        onChange={(e) => setSlice(axis, Number(e.target.value))}
      />
    </div>
  );
}
