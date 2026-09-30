import type { AxisName, Point3, Volume } from "../types";
import { indexToPhysicalCoord, physicalToIndexCoord } from "./geometry";

/**
 * 三个正交视图。画布方向固定（不随体数据翻转改变），
 * 翻转只影响取数时的下标映射，从而保证同一体素在三视图中的对应关系正确。
 *
 * axial（轴状）：法线 z，列=x 向右，行=y 向下
 * coronal（冠状）：法线 y，列=x 向右，行=z 向下
 * sagittal（矢状）：法线 x，列=y 向右，行=z 向下
 */
export interface ViewSpec {
  key: "axial" | "coronal" | "sagittal";
  label: string;
  normal: AxisName;
  colAxis: AxisName;
  rowAxis: AxisName;
}

export const VIEWS: ViewSpec[] = [
  { key: "axial", label: "轴状位 (Axial)", normal: "z", colAxis: "x", rowAxis: "y" },
  { key: "coronal", label: "冠状位 (Coronal)", normal: "y", colAxis: "x", rowAxis: "z" },
  { key: "sagittal", label: "矢状位 (Sagittal)", normal: "x", colAxis: "y", rowAxis: "z" },
];

export interface MprSlice {
  width: number;
  height: number;
  values: Uint16Array;
  min: number;
  max: number;
}

export function sampleSlice(vol: Volume, view: ViewSpec, normalIndex: number): MprSlice {
  const width = vol.dims[view.colAxis];
  const height = vol.dims[view.rowAxis];
  const values = new Uint16Array(width * height);
  let min = Infinity;
  let max = -Infinity;
  const idx = { x: 0, y: 0, z: 0 } as Record<AxisName, number>;
  idx[view.normal] = normalIndex;
  for (let row = 0; row < height; row++) {
    idx[view.rowAxis] = vol.flip[view.rowAxis] ? height - 1 - row : row;
    for (let col = 0; col < width; col++) {
      idx[view.colAxis] = vol.flip[view.colAxis] ? width - 1 - col : col;
      const v = vol.data[idx.x + vol.dims.x * (idx.y + vol.dims.y * idx.z)];
      values[row * width + col] = v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  return { width, height, values, min: min === Infinity ? 0 : min, max };
}

/** 画布像素（col,row，整数体素下标）-> 物理坐标（毫米）；法线坐标由当前层决定。 */
export function canvasToPhysical(
  vol: Volume,
  view: ViewSpec,
  col: number,
  row: number,
  normalIndex: number
): Point3 {
  const i = { x: 0, y: 0, z: 0 } as Record<AxisName, number>;
  i[view.normal] = normalIndex;
  i[view.colAxis] = vol.flip[view.colAxis] ? vol.dims[view.colAxis] - 1 - col : col;
  i[view.rowAxis] = vol.flip[view.rowAxis] ? vol.dims[view.rowAxis] - 1 - row : row;
  return indexToPhysicalCoord(i, vol);
}

/** 物理坐标 -> 该视图画布像素（浮点）。 */
export function physicalToCanvas(
  vol: Volume,
  view: ViewSpec,
  p: Point3
): { col: number; row: number; normalIndex: number } {
  const i = physicalToIndexCoord(p, vol);
  const col = vol.flip[view.colAxis] ? vol.dims[view.colAxis] - 1 - i[view.colAxis] : i[view.colAxis];
  const row = vol.flip[view.rowAxis] ? vol.dims[view.rowAxis] - 1 - i[view.rowAxis] : i[view.rowAxis];
  return { col, row, normalIndex: i[view.normal] };
}
