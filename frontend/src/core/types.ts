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
  // 原始来源标识（文件名/SOP 实例号），用于导入预览与重开后追溯
  sourceName?: string;
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
  // 导入判定（仅外部帧序列组卷时存在）
  importInfo?: ImportInfo;
}

// 一次帧序列导入的空间排列判定与原始来源
export interface ImportInfo {
  // 原始文件/帧的来源顺序索引 -> 排序后体数据层号 k 的映射
  sourceOrder: number[];
  frameCount: number;
  // 原始帧提供顺序沿切片轴的走向，如头侧→足侧
  sourceDirectionLabel: string;
  // 排序后体数据 k 轴递增方向的解剖方位
  layerDirectionLabel: string;
  // 提供顺序是否与空间顺序相反（整批层序翻转，属合法重排，不是错误）
  reversedOrder: boolean;
  // 提供顺序中是否存在乱序帧（位置前后错位，已按位置重排）
  shuffled: boolean;
  // 原始来源文件名/标识（按提供顺序）
  sourceNames: string[];
}

export interface Measurement {
  id: string;
  p1: Vec3; // 患者坐标 mm
  p2: Vec3;
  distance: number; // mm
  createdAt: number;
  // 测量复核状态：confirmed=已确认；review=其所依据的切片内容被替换/补全，需要人工复核
  reviewStatus?: 'confirmed' | 'review';
  // 测量所依据的采集版本（批次 id）；原始体数据为 'base'
  basisVersion?: string;
  // 最近一次状态判定时，两端点是否都落在有效影像范围内（在包围盒内且不在缺片层）
  endpointsInRange?: boolean;
}

export class VolumeBuildError extends Error {
  reasons: string[];
  constructor(reasons: string[]) {
    super(reasons.join('；'));
    this.name = 'VolumeBuildError';
    this.reasons = reasons;
  }
}
