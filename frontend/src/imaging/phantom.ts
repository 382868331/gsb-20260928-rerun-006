import type { AxisName, Orientation, SliceSeries } from "../types";

export interface PhantomSpec {
  dims: Record<AxisName, number>;
  spacing: Record<AxisName, number>;
  flip: Record<AxisName, boolean>;
  /** 0..1，挖掉中间层的比例，形成空腔。 */
  cavityFraction: number;
}

export const DEFAULT_SPEC: PhantomSpec = {
  dims: { x: 24, y: 20, z: 16 },
  spacing: { x: 1.0, y: 1.5, z: 2.5 },
  flip: { x: false, y: true, z: true },
  cavityFraction: 0.22,
};

/**
 * 生成带标记的人工体模：
 * - 外框高值，内部中灰，中央球形空腔为 0；
 * - 三个互相垂直、间距等于体素间距的标记点（亮度 4095），
 *   用于在三个视图中核对同一点对应关系与距离测量；
 * - 每个轴端点附近各放一个标记，便于肉眼判断方向翻转。
 */
export function phantomVoxel(spec: PhantomSpec, x: number, y: number, z: number): number {
  const { dims } = spec;
  const cx = (dims.x - 1) / 2;
  const cy = (dims.y - 1) / 2;
  const cz = (dims.z - 1) / 2;
  const rx = (dims.x / 2) * spec.cavityFraction;
  const ry = (dims.y / 2) * spec.cavityFraction;
  const rz = (dims.z / 2) * spec.cavityFraction;
  const inCavity =
    ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 + ((z - cz) / rz) ** 2 <= 1;
  if (inCavity) return 0;

  const onShell =
    x === 0 || y === 0 || z === 0 || x === dims.x - 1 || y === dims.y - 1 || z === dims.z - 1;
  let v = onShell ? 2400 : 1200;

  const markers = markerPoints(spec);
  for (const m of markers) {
    if (x === m.x && y === m.y && z === m.z) v = 4095;
  }
  return v;
}

export function markerPoints(spec: PhantomSpec): Array<Point3i> {
  const { dims } = spec;
  const c = {
    x: Math.floor(dims.x / 2) + 2,
    y: Math.floor(dims.y / 2) + 2,
    z: Math.floor(dims.z / 2) + 2,
  };
  return [
    c,
    { x: c.x + 3, y: c.y, z: c.z },
    { x: c.x, y: c.y + 2, z: c.z },
    { x: c.x, y: c.y, z: c.z + 2 },
    { x: 2, y: 2, z: 2 },
    { x: dims.x - 3, y: dims.y - 3, z: dims.z - 3 },
  ];
}

interface Point3i {
  x: number;
  y: number;
  z: number;
}

/** 体模生成坐标（x/y/z 为数组列/行/层下标）-> 组装后体数据下标（考虑 flip）。 */
export function phantomToVolumeIndex(spec: PhantomSpec, p: Point3i): Point3i {
  return {
    x: spec.flip.x ? spec.dims.x - 1 - p.x : p.x,
    y: spec.flip.y ? spec.dims.y - 1 - p.y : p.y,
    z: spec.flip.z ? spec.dims.z - 1 - p.z : p.z,
  };
}

export function phantomOrientation(spec: PhantomSpec): Orientation {
  return {
    spacing: { ...spec.spacing },
    colAxis: "x",
    rowAxis: "y",
    normalAxis: "z",
    flip: { ...spec.flip },
  };
}

/** 按切片（层轴 z）输出，层位置为物理坐标，顺序可任意（组装时按位置归位）。 */
export function buildPhantomSeries(spec: PhantomSpec): SliceSeries {
  const slices = [];
  for (let k = 0; k < spec.dims.z; k++) {
    const z = spec.flip.z ? spec.dims.z - 1 - k : k;
    const pixels = new Uint16Array(spec.dims.x * spec.dims.y);
    for (let y = 0; y < spec.dims.y; y++) {
      for (let x = 0; x < spec.dims.x; x++) {
        pixels[y * spec.dims.x + x] = phantomVoxel(spec, x, y, z);
      }
    }
    slices.push({
      position: k * spec.spacing.z,
      width: spec.dims.x,
      height: spec.dims.y,
      pixels,
    });
  }
  return { orientation: phantomOrientation(spec), slices };
}

/** 删掉指定物理位置的层，用于构造缺片影像。 */
export function dropSlice(series: SliceSeries, physicalZ: number): SliceSeries {
  return {
    orientation: series.orientation,
    slices: series.slices.filter((s) => Math.abs(s.position - physicalZ) > 1e-6),
  };
}
