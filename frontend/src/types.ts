export type AxisName = "x" | "y" | "z";

/**
 * 影像方向与几何信息。所有坐标单位为毫米（物理坐标，原点 0,0,0）。
 *
 * - spacing：体素在物理 x/y/z 三个方向上的间距（必须 > 0）。
 * - colAxis / rowAxis / normalAxis：切片数组的列、行、层号所对应的物理轴。
 * - flip：某一轴数组下标增大时物理坐标反而减小（方向翻转）。
 *
 * 物理坐标到体素下标：
 *   index = originIndex(ax) + sign(ax) * position / spacing(ax)
 */
export interface Orientation {
  spacing: Record<AxisName, number>;
  colAxis: AxisName;
  rowAxis: AxisName;
  normalAxis: AxisName;
  flip: Record<AxisName, boolean>;
}

export interface SliceMeta {
  /** 该层中心在 normalAxis 方向上的物理坐标（毫米）。 */
  position: number;
  width: number;
  height: number;
  /** 行优先的 16 位灰度数据。 */
 pixels: Uint16Array;
}

export interface SliceSeries {
  orientation: Orientation;
  slices: SliceMeta[];
}

export interface Volume {
  id: string;
  dims: Record<AxisName, number>;
  spacing: Record<AxisName, number>;
  flip: Record<AxisName, boolean>;
  /** voxel[x + dims.x*(y + dims.y*z)] */
  data: Uint16Array;
  /** 由几何参数推导出的稳定签名，用于判定两次打开的是否为同一影像。 */
  signature: string;
  description: string;
}

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

export type MeasurementType = "distance" | "point";

export interface Measurement {
  id: string;
  volumeId: string;
  type: MeasurementType;
  /** 物理坐标（毫米），与体数据采用同一坐标系。 */
  points: Point3[];
  distanceMm: number | null;
  label: string;
  createdAt: number;
}
