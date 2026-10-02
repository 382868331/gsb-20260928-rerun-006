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
  // 每一层切片的采用清单（含缺片空槽）；缺片层在 data 中以 NaN 占位
  sliceManifest?: SliceSlot[];
  // 到达的采集批次（初始采集 + 每次补片/替换片批次）
  acquisitions?: AcquisitionInfo[];
  // 每个空间位置上候选切片的采用决定（含被拒绝的替换片）
  sliceDecisions?: SliceDecision[];
  // 双审阅分支与合并结果的可追溯状态
  reviewState?: ReviewState;
}

export interface ReviewBranch {
  id: string;
  label: string;
  baseAcquisitionId: string;
  volume: Volume;
  measurements: Measurement[];
  createdAt: number;
}

export interface MergeLayerResolution {
  layer: number;
  reviewId: string;
  contentHash: string;
  decidedAt: number;
}

export interface ReviewState {
  baseAcquisitionId: string;
  branches: Record<string, Omit<ReviewBranch, 'volume'>>;
  mergedFrom?: { reviewIds: [string, string]; mergedAt: number };
  resolutions?: MergeLayerResolution[];
  withdrawnResolutions?: MergeLayerResolution[];
  withdrawnLayers?: number[];
  reopenedLayers?: number[];
}

// 体数据沿切片轴的一个槽位：已采用的切片或仍空缺（缺片）
export interface SliceSlot {
  t: number; // 沿切片轴的患者坐标投影 (mm)
  layer: number; // 体数据层号 k
  status: 'adopted' | 'missing';
  sourceName: string | null;
  // 该层内容来自哪一版采集
  acquisition: string | null;
  // 像素内容指纹；相同层号/名称但指纹不同不能视为同一依据
  contentHash?: string;
  // 几何指纹：尺寸、间距、方向、位置共同决定候选是否落在同一空间位置
  geometryHash?: string;
}

export interface AcquisitionInfo {
  id: string;
  label: string;
  kind: 'initial' | 'patch';
  arrivedAt: number;
}

// 同一空间位置上多张候选切片的采用决定
export interface SliceDecision {
  t: number;
  layer: number;
  adopted: { sourceName: string; acquisition: string } | null; // null = 仍缺片
  rejected: Array<{ sourceName: string; acquisition: string }>;
  decidedAt: number;
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
  // 测量所依据的采集版本 id（作出该测量时体数据的内容版本）
  basisAcquisition?: string;
  // 测量实际采样的切片集合；跨层直线测量会包含两个端点之间的所有整数层
  basisLayers?: MeasurementSliceBasis[];
  // 来源审阅分支；合并后的测量可追溯到任一份独立审阅
  sourceReviewId?: string;
  // 替换片改变了相关切片内容时进入待复核；未受影响保持 confirmed
  review?: 'confirmed' | 'pending';
}

export interface MeasurementSliceBasis {
  t: number;
  layer: number;
  contentHash: string;
  geometryHash?: string;
  sourceName: string | null;
  acquisition: string | null;
}

export class VolumeBuildError extends Error {
  reasons: string[];
  constructor(reasons: string[]) {
    super(reasons.join('；'));
    this.name = 'VolumeBuildError';
    this.reasons = reasons;
  }
}
