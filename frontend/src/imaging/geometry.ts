import type { AxisName, Orientation, Point3, SliceSeries, Volume } from "../types";

export const AXES: AxisName[] = ["x", "y", "z"];

export function sign(ax: AxisName, flip: Record<AxisName, boolean>): 1 | -1 {
  return flip[ax] ? -1 : 1;
}

/** 物理坐标（毫米，相对原点）-> 体素下标（浮点）。 */
export function physicalToIndexCoord(p: Point3, vol: Pick<Volume, "dims" | "spacing" | "flip">): Point3 {
  const out: Point3 = { x: 0, y: 0, z: 0 };
  for (const ax of AXES) {
    const originIndex = vol.flip[ax] ? vol.dims[ax] - 1 : 0;
    out[ax] = originIndex + (vol.flip[ax] ? -1 : 1) * (p[ax] / vol.spacing[ax]);
  }
  return out;
}

/** 体素下标（浮点）-> 物理坐标（毫米）。 */
export function indexToPhysicalCoord(i: Point3, vol: Pick<Volume, "dims" | "spacing" | "flip">): Point3 {
  const out: Point3 = { x: 0, y: 0, z: 0 };
  for (const ax of AXES) {
    const originIndex = vol.flip[ax] ? vol.dims[ax] - 1 : 0;
    out[ax] = (i[ax] - originIndex) * (vol.flip[ax] ? -1 : 1) * vol.spacing[ax];
  }
  return out;
}

export function clampIndex(v: number, max: number): number {
  return Math.max(0, Math.min(max, v));
}

export function distanceMm(a: Point3, b: Point3): number {
  return Math.sqrt(AXES.reduce((s, ax) => s + (a[ax] - b[ax]) ** 2, 0));
}

/**
 * 期望的各层物理位置（normalAxis 方向），按体素栅格中心给出。
 */
export function expectedSlicePositions(ori: Orientation, count: number): number[] {
  const sp = ori.spacing[ori.normalAxis];
  const out: number[] = [];
  for (let k = 0; k < count; k++) {
    out.push(k * sp);
  }
  return out;
}

function validOrientation(ori: Orientation): string | null {
  const { colAxis, rowAxis, normalAxis } = ori;
  if (new Set([colAxis, rowAxis, normalAxis]).size !== 3) {
    return "方向定义冲突：列轴、行轴、层轴必须恰好是 x/y/z 三个互不相同的轴";
  }
  for (const ax of AXES) {
    if (!(ori.spacing[ax] > 0) || !Number.isFinite(ori.spacing[ax])) {
      return `体素间距非法：${ax} 轴间距必须为正数（得到 ${ori.spacing[ax]}）`;
    }
  }
  return null;
}

export interface BuildResult {
  volume: Volume | null;
  errors: string[];
}

/**
 * 由切片序列组装规则体数据。任何几何/完整性问题都返回错误，
 * 不返回部分体数据（调用方据此保留原有影像与测量）。
 */
export function buildVolume(series: SliceSeries, id: string, description = ""): BuildResult {
  const errors: string[] = [];
  const ori = series.orientation;
  const orientationError = validOrientation(ori);
  if (orientationError) {
    return { volume: null, errors: [orientationError] };
  }

  const slices = series.slices;
  if (slices.length === 0) {
    return { volume: null, errors: ["切片序列为空，无法组成体数据"] };
  }

  const w = slices[0].width;
  const h = slices[0].height;
  if (w <= 0 || h <= 0) {
    return { volume: null, errors: ["切片宽高非法"] };
  }
  for (let i = 0; i < slices.length; i++) {
    const sl = slices[i];
    if (sl.width !== w || sl.height !== h) {
      errors.push(`第 ${i + 1} 层尺寸为 ${sl.width}x${sl.height}，与首层 ${w}x${h} 不一致`);
    }
    if (sl.pixels.length !== sl.width * sl.height) {
      errors.push(`第 ${i + 1} 层像素数 ${sl.pixels.length} 与 ${sl.width}x${sl.height}=${sl.width * sl.height} 不符`);
    }
  }

  const normal = ori.normalAxis;
  const spN = ori.spacing[normal];
  const positions = slices.map((s) => s.position);
  const sorted = [...positions].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i] - sorted[i - 1];
    if (gap <= 1e-6) {
      errors.push(`存在重复的层位置（${sorted[i - 1]} mm）`);
      break;
    }
  }

  const expected = expectedSlicePositions(ori, slices.length);
  const expectedSet = new Set(expected.map((v) => Math.round(v * 1000) / 1000));
  const tolerance = spN * 0.25;
  const missing: number[] = [];
  for (const e of expected) {
    if (!positions.some((p) => Math.abs(p - e) <= tolerance)) missing.push(e);
  }
  if (missing.length > 0) {
    errors.push(
      `缺片：共 ${slices.length} 层，但沿 ${normal} 轴缺少位置 ${missing
        .map((m) => m.toFixed(2))
        .join(", ")} mm 的切片（层间距应为 ${spN} mm）`
    );
  }
  const extra: number[] = [];
  for (const p of positions) {
    if (!expectedSet.has(Math.round(p * 1000) / 1000)) extra.push(p);
  }
  if (extra.length > 0) {
    errors.push(`存在超出体数据栅格范围的层位置：${extra.map((p) => p.toFixed(2)).join(", ")} mm`);
  }

  if (errors.length > 0) return { volume: null, errors };

  const dims = { x: 0, y: 0, z: 0 } as Record<AxisName, number>;
  dims[ori.colAxis] = w;
  dims[ori.rowAxis] = h;
  dims[normal] = slices.length;
  const flip = { ...ori.flip };

  const data = new Uint16Array(dims.x * dims.y * dims.z);
  const voxel = (x: number, y: number, z: number, v: number) => {
    data[x + dims.x * (y + dims.y * z)] = v;
  };

  for (const sl of slices) {
    const normalIndex = Math.round(sl.position / spN);
    const k = normalIndex;
    for (let row = 0; row < h; row++) {
      for (let col = 0; col < w; col++) {
        const iv = { x: 0, y: 0, z: 0 } as Record<AxisName, number>;
        iv[normal] = k;
        iv[ori.colAxis] = flip[ori.colAxis] ? w - 1 - col : col;
        iv[ori.rowAxis] = flip[ori.rowAxis] ? h - 1 - row : row;
        voxel(iv.x, iv.y, iv.z, sl.pixels[row * w + col]);
      }
    }
  }

  const signatureParts = [
    dims.x, dims.y, dims.z,
    ori.spacing.x.toFixed(4), ori.spacing.y.toFixed(4), ori.spacing.z.toFixed(4),
    flip.x ? 1 : 0, flip.y ? 1 : 0, flip.z ? 1 : 0,
    checksum(data),
  ];
  const signature = signatureParts.join("|");

  return {
    volume: {
      id: `vol-${signature}`,
      dims,
      spacing: { ...ori.spacing },
      flip,
      data,
      signature,
      description,
    },
    errors: [],
  };
}

function checksum(data: Uint16Array): number {
  let h = 2166136261 >>> 0;
  const step = Math.max(1, Math.floor(data.length / 4096));
  for (let i = 0; i < data.length; i += step) {
    h ^= data[i];
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
