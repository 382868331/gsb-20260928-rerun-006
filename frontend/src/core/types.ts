export type Vec3 = readonly [number, number, number];

// 行优先 3x3，列向量为 I/J/K 三个体素轴在患者坐标系(LPS)中的单位方向
export type Mat3 = readonly [number, number, number, number, number, number, number, number, number];

// 一帧二维切片（类 DICOM 影像信息）
// pixelData 按 [列 i, 行 j] 存储，长度 rows*cols
export interface ImageFrame {
  rows: number;
  cols: number;
  // 相邻两行/两列体素中心的物理间距(mm)
  rowSpacing: number;
  colSpacing: number;
  // (row=0,col=0) 体素中心的患者坐标
  imagePositionPatient: Vec3;
  // [沿列递增方向, 沿行递增方向] 的单位方向余弦
  imageOrientationPatient: readonly [Vec3, Vec3];
  pixelData: ArrayLike<number>;
}

export interface Volume {
  id: string;
  label: string;
  dimensions: [number, number, number]; // 体素数 nx,ny,nz
  spacing: [number, number, number]; // mm / 体素
  // 列向量 = 体素轴方向；行列式可为 -1（允许方向翻转）
  direction: Mat3;
  origin: Vec3; // 体素 (0,0,0) 中心的患者坐标
  data: Float32Array; // index = i + j*nx + k*nx*ny
  window: { center: number; width: number };
}

export interface Measurement {
  id: string;
  p1: Vec3; // 患者坐标 mm
  p2: Vec3;
  distance: number; // mm
  createdAt: number;
}

export class VolumeBuildError extends Error {
  reasons: string[];
  constructor(reasons: string[]) {
    super(reasons.join('；'));
    this.name = 'VolumeBuildError';
    this.reasons = reasons;
  }
}
