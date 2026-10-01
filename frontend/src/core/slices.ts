import type { Vec3, Volume } from './types';
import { ijkToWorld } from './geometry';

export type Axis = 0 | 1 | 2;

// axis 表示被固定的体素轴：0=矢状(固定I)，1=冠状(固定J)，2=轴向(固定K)
export interface SlicePlane {
  axis: Axis;
  title: string;
}

export const SLICE_PLANES: SlicePlane[] = [
  { axis: 2, title: '轴向 Axial' },
  { axis: 1, title: '冠状 Coronal' },
  { axis: 0, title: '矢状 Sagittal' },
];

export function sliceSize(volume: Volume, axis: Axis): [number, number] {
  // 平面上的两个轴，顺序保证显示方向的一致性
  if (axis === 0) return [volume.dimensions[1], volume.dimensions[2]];
  if (axis === 1) return [volume.dimensions[0], volume.dimensions[2]];
  return [volume.dimensions[0], volume.dimensions[1]];
}

export function planeAxes(axis: Axis): [Axis, Axis] {
  if (axis === 0) return [1, 2];
  if (axis === 1) return [0, 2];
  return [0, 1];
}

export function extractSlice(volume: Volume, axis: Axis, slice: number): Float32Array {
  const [nx, ny, nz] = volume.dimensions;
  const [uAxis, vAxis] = planeAxes(axis);
  const dims: [number, number, number] = [nx, ny, nz];
  const nu = dims[uAxis];
  const nv = dims[vAxis];
  const out = new Float32Array(nu * nv);
  const idx: [number, number, number] = [0, 0, 0];
  idx[axis] = Math.round(slice);
  for (let v = 0; v < nv; v += 1) {
    idx[vAxis] = v;
    for (let u = 0; u < nu; u += 1) {
      idx[uAxis] = u;
      out[u + v * nu] = volume.data[idx[0] + idx[1] * nx + idx[2] * nx * ny];
    }
  }
  return out;
}

// 平面像素(u,v) -> 体素索引 -> 患者坐标（距离由 spacing/direction 解释，非数组下标）
export function planeToWorld(
  volume: Volume,
  axis: Axis,
  slice: number,
  u: number,
  v: number,
): Vec3 {
  const [uAxis, vAxis] = planeAxes(axis);
  const ijk: [number, number, number] = [0, 0, 0];
  ijk[axis] = slice;
  ijk[uAxis] = u;
  ijk[vAxis] = v;
  return ijkToWorld(ijk, volume.origin, volume.direction, volume.spacing);
}

export function windowLevel(value: number, center: number, width: number): number {
  if (!Number.isFinite(value)) return 0;
  if (width <= 0) return 0;
  const v = ((value - (center - width / 2)) / width) * 255;
  return Math.max(0, Math.min(255, Math.round(v)));
}
