import type { ImageFrame, Mat3, Vec3, Volume } from './types';
import { buildVolumeFromFrames } from './series';
import { ijkToWorld, makeMat3 } from './geometry';

export interface PhantomDef {
  key: string;
  label: string;
  dimensions: [number, number, number];
  spacing: [number, number, number];
  // k 轴方向；取 (0,0,-1) 模拟头侧→足侧的翻转层序
  layerDir: Vec3;
  origin: Vec3;
  markerIjk: [number, number, number];
}

export const PHANTOM_CATALOG: PhantomDef[] = [
  {
    key: 'cavity-flip',
    label: '空腔·翻转层序·不等间距',
    dimensions: [24, 20, 16],
    spacing: [1.2, 0.8, 2.5],
    layerDir: [0, 0, -1],
    origin: [-14.4, -8.0, 40.0],
    markerIjk: [18, 5, 12],
  },
];

function phantomDirection(def: PhantomDef): Mat3 {
  // 轴向切片：列方向朝左(L)，行方向朝后(P)，层方向按 def.layerDir（可朝足侧翻转）
  return makeMat3([
    [1, 0, 0],
    [0, 1, 0],
    def.layerDir,
  ]);
}

// 解析构造型数据：亮壳包暗腔 + 一个高亮点用于三视图同点验证
export function createAnalyticVolume(def: PhantomDef): Volume {
  const [nx, ny, nz] = def.dimensions;
  const data = new Float32Array(nx * ny * nz);
  const cx = (nx - 1) / 2;
  const cy = (ny - 1) / 2;
  const cz = (nz - 1) / 2;
  const rx = nx * 0.38;
  const ry = ny * 0.38;
  const rz = nz * 0.42;
  const [mx, my, mz] = def.markerIjk;

  for (let k = 0; k < nz; k += 1) {
    for (let j = 0; j < ny; j += 1) {
      for (let i = 0; i < nx; i += 1) {
        const d2 =
          ((i - cx) / rx) ** 2 +
          ((j - cy) / ry) ** 2 +
          ((k - cz) / rz) ** 2;
        let v = 0;
        if (d2 < 1) v = d2 > 0.55 ? 200 : 20; // 亮壳 + 暗空腔
        const md = Math.sqrt((i - mx) ** 2 + (j - my) ** 2 + (k - mz) ** 2);
        if (md <= 1.2) v = 255; // 标记点（小球，便于三视图定位同一点）
        data[i + j * nx + k * nx * ny] = v;
      }
    }
  }

  return {
    id: phantomId(def),
    label: def.label,
    dimensions: def.dimensions,
    spacing: def.spacing,
    direction: phantomDirection(def),
    origin: def.origin,
    data,
    window: { center: 120, width: 240 },
  };
}

export function phantomId(def: PhantomDef): string {
  return `phantom:${def.key}`;
}

// 从体数据反推一帧帧 2D 影像；reversed=true 时按翻转层序给出（影像仍合法）
export function volumeToFrames(volume: Volume, reversed = false): ImageFrame[] {
  const [nx, ny, nz] = volume.dimensions;
  const frames: ImageFrame[] = [];
  const colDir: Vec3 = [volume.direction[0], volume.direction[3], volume.direction[6]];
  const rowDir: Vec3 = [volume.direction[1], volume.direction[4], volume.direction[7]];
  for (let kk = 0; kk < nz; kk += 1) {
    const k = reversed ? nz - 1 - kk : kk;
    frames.push({
      rows: ny,
      cols: nx,
      rowSpacing: volume.spacing[1],
      colSpacing: volume.spacing[0],
      imagePositionPatient: ijkToWorld([0, 0, k], volume.origin, volume.direction, volume.spacing),
      imageOrientationPatient: [colDir, rowDir],
      pixelData: volume.data.subarray(k * nx * ny, (k + 1) * nx * ny),
      sourceName: `${volume.label}/slice-${String(k).padStart(3, '0')}.dcm`,
    });
  }
  return frames;
}

export type FaultMode = 'none' | 'missing' | 'conflict' | 'shuffle' | 'mixed';

// 生成可能带故障的帧序列，用于验证组卷校验
export function buildFaultyFrames(
  def: PhantomDef,
  mode: FaultMode,
): {
  frames: ImageFrame[];
  missingK?: number;
  conflictK?: number;
  duplicateK?: number;
  oppositeK?: number;
  shuffleSwapped?: [number, number];
} {
  const volume = createAnalyticVolume(def);
  const reversed = true; // 默认即翻转层序
  let frames = volumeToFrames(volume, reversed);
  let missingK: number | undefined;
  let conflictK: number | undefined;
  let duplicateK: number | undefined;
  let oppositeK: number | undefined;
  let shuffleSwapped: [number, number] | undefined;
  if (mode === 'missing') {
    missingK = Math.floor(def.dimensions[2] / 2);
    // reversed 输出中体素 k 位于索引 nz-1-k
    const dropIndex = def.dimensions[2] - 1 - missingK;
    frames = frames.filter((_, idx) => idx !== dropIndex);
  } else if (mode === 'conflict') {
    conflictK = 3;
    const idx = def.dimensions[2] - 1 - conflictK;
    const f = frames[idx];
    frames[idx] = {
      ...f,
      // 平面旋转 90°：列/行方向与其余帧冲突，无法对齐到同一栅格
      imageOrientationPatient: [
        [0, -1, 0],
        [1, 0, 0],
      ],
    };
  } else if (mode === 'shuffle') {
    // 仅打乱提供顺序（交换两帧），位置/方向都合法，应能按空间位置重排组卷
    const nz = def.dimensions[2];
    const a = 2;
    const b = 9;
    shuffleSwapped = [nz - 1 - a, nz - 1 - b];
    [frames[a], frames[b]] = [frames[b], frames[a]];
  } else if (mode === 'mixed') {
    // 乱序 + 重复位置 + 缺片 + 相反方向 混在同一批，要求分别报告
    const nz = def.dimensions[2];
    const swapA = 1;
    const swapB = 12;
    [frames[swapA], frames[swapB]] = [frames[swapB], frames[swapA]];
    shuffleSwapped = [swapA, swapB];

    missingK = 7;
    const dropIndex = nz - 1 - missingK;
    frames = frames.filter((_, idx) => idx !== dropIndex);

    // 重复位置：复制一帧并改成与另一帧相同的 imagePositionPatient
    duplicateK = 5;
    const dupSource = nz - 1 - duplicateK;
    frames.push({
      ...frames[dupSource],
      sourceName: `${def.label}/DUPLICATE-of-slice-${String(duplicateK).padStart(3, '0')}.dcm`,
    });

    // 相反方向：翻转一个平面轴使法线反向，平面仍平行于切片轴
    oppositeK = 9;
    const oppIndex = frames.findIndex(
      (fr) => fr.sourceName?.includes(`slice-${String(oppositeK).padStart(3, '0')}.dcm`),
    );
    if (oppIndex >= 0) {
      const f = frames[oppIndex];
      frames[oppIndex] = {
        ...f,
        // 仅翻转列方向：法线随之反向，但平面仍平行 —— 方向翻转冲突
        imageOrientationPatient: [
          [-f.imageOrientationPatient[0][0], -f.imageOrientationPatient[0][1], -f.imageOrientationPatient[0][2]],
          f.imageOrientationPatient[1],
        ],
        sourceName: `${def.label}/OPPOSITE-slice-${String(oppositeK).padStart(3, '0')}.dcm`,
      };
    }
  }
  return { frames, missingK, conflictK, duplicateK, oppositeK, shuffleSwapped };
}

// 通过完整帧管线重建合法体数据（覆盖翻转层序排序路径）
export function buildPhantomFromFrames(def: PhantomDef): Volume {
  const volume = createAnalyticVolume(def);
  const rebuilt = buildVolumeFromFrames(volumeToFrames(volume, true), def.label, volume.window);
  // 帧管线重建的是同一影像，保留稳定的数据集 id，重开后才能找回测量与浏览位置
  return { ...rebuilt, id: phantomId(def) };
}
