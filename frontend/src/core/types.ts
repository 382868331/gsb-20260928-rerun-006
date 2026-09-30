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
  // 帧序列导入时记录的来源与导入判断；内置体模直接打开时为空
  importInfo?: ImportInfo;
}

// 一帧在空间排列中的方向归类
// consistent：与参考帧同向；opposite：列/行均反向（面内旋转180°）；
// mirror-col/mirror-row：仅一个方向反向（镜像）；inconsistent：非共栅格方向
export type OrientationKind =
  | 'consistent'
  | 'opposite'
  | 'mirror-col'
  | 'mirror-row'
  | 'inconsistent';

// 导入前对一批切片做出的空间排列判断，随数据一起持久化（“保存重开保留导入判断”）
export interface ImportJudgment {
  frameCount: number;
  layerSpacingMm: number | null;
  // 输入（文件）顺序沿切片轴是递增、递减（整体翻转层序）还是乱序
  inputOrdering: 'ascending' | 'descending' | 'shuffled';
  // 是否发生了重排：输入序号 -> 空间层号
  orderMap: number[];
  reordered: boolean;
  // 整批层序方向与首帧法线相反（合法的整体翻转，区别于单帧方向翻转）
  fullStackFlipped: boolean;
  layerAxisLabel: string;
  planeLabels: [string, string];
}

export interface ImportInfo {
  sourceName: string;
  importedAt: number;
  judgment: ImportJudgment;
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
