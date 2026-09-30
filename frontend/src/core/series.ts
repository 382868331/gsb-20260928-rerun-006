import type { ImageFrame, Mat3, Vec3, Volume } from './types';
import { VolumeBuildError } from './types';
import {
  cross,
  directionLabel,
  dot,
  EPS,
  makeMat3,
  norm,
  stableHash,
  vecSub,
} from './geometry';

function approxUnit(v: Vec3): boolean {
  return Math.abs(norm(v) - 1) < 1e-3;
}

function nearlyParallel(a: Vec3, b: Vec3): boolean {
  return Math.abs(dot(a, b)) > 1 - 1e-3;
}

// 把一组 2D 影像帧组装成完整体数据；任何缺片或方向冲突都会抛出原因列表。
export function buildVolumeFromFrames(
  frames: ImageFrame[],
  label: string,
  window: Volume['window'],
): Volume {
  const reasons: string[] = [];
  if (frames.length === 0) reasons.push('序列为空：没有任何影像帧');
  if (frames.length < 2) reasons.push('切片数量不足：至少需要 2 帧才能确定层间距');
  if (reasons.length > 0) throw new VolumeBuildError(reasons);

  const rows = frames[0].rows;
  const cols = frames[0].cols;
  const rowSpacing = frames[0].rowSpacing;
  const colSpacing = frames[0].colSpacing;
  if (!(rows > 0 && cols > 0)) reasons.push(`帧尺寸非法：rows=${rows}, cols=${cols}`);
  if (!(rowSpacing > 0 && Number.isFinite(rowSpacing)) ||
      !(colSpacing > 0 && Number.isFinite(colSpacing))) {
    reasons.push(`像素间距非法或非正：rowSpacing=${rowSpacing}, colSpacing=${colSpacing}`);
  }

  for (let f = 0; f < frames.length; f += 1) {
    const frame = frames[f];
    if (frame.rows !== rows || frame.cols !== cols) {
      reasons.push(`第 ${f} 帧尺寸 ${frame.cols}x${frame.rows} 与首帧 ${cols}x${rows} 不一致`);
    }
    const expected = rows * cols;
    if (frame.pixelData.length !== expected) {
      reasons.push(`第 ${f} 帧像素数 ${frame.pixelData.length}，应为 ${expected}`);
    }
    if (!(frame.rowSpacing > 0) || !(frame.colSpacing > 0)) {
      reasons.push(`第 ${f} 帧像素间距非正`);
    }
    if (Math.abs(frame.rowSpacing - rowSpacing) > 1e-6 ||
        Math.abs(frame.colSpacing - colSpacing) > 1e-6) {
      reasons.push(`第 ${f} 帧像素间距与首帧不一致`);
    }
    const [colDir, rowDir] = frame.imageOrientationPatient;
    if (!approxUnit(colDir) || !approxUnit(rowDir)) {
      reasons.push(`第 ${f} 帧方向余弦不是单位向量`);
    }
    if (Math.abs(dot(colDir, rowDir)) > 1e-3) {
      reasons.push(`第 ${f} 帧行/列方向不垂直`);
    }
  }
  if (reasons.length > 0) throw new VolumeBuildError(reasons);

  const [baseColDir, baseRowDir] = frames[0].imageOrientationPatient;
  for (let f = 1; f < frames.length; f += 1) {
    const [colDir, rowDir] = frames[f].imageOrientationPatient;
    if (!nearlyParallel(colDir, baseColDir) ||
        !nearlyParallel(rowDir, baseRowDir)) {
      reasons.push(`第 ${f} 帧方向 (${directionLabel(colDir)}/${directionLabel(rowDir)}) 与首帧冲突，无法对齐到同一栅格`);
    }
  }

  // 用帧平面法线（行×列）作为切片轴，按沿轴投影排序
  const frameNormal = cross(frames[0].imageOrientationPatient[1], frames[0].imageOrientationPatient[0]);
  const axisStep: Array<{ index: number; t: number }> = [];
  for (let f = 0; f < frames.length; f += 1) {
    axisStep.push({ index: f, t: dot(frames[f].imagePositionPatient, frameNormal) });
  }
  axisStep.sort((a, b) => a.t - b.t);

  // 以最小层间步长为栅格间距；整数倍的空档说明中间缺片，非整数倍说明栅格不等距
  let layerSpacing = Infinity;
  for (let i = 1; i < axisStep.length; i += 1) {
    const delta = axisStep[i].t - axisStep[i - 1].t;
    if (!(delta > EPS)) {
      reasons.push(`第 ${axisStep[i].index} 帧与第 ${axisStep[i - 1].index} 帧位置重合，存在重复切片`);
    } else {
      layerSpacing = Math.min(layerSpacing, delta);
    }
  }
  if (reasons.length > 0) throw new VolumeBuildError(reasons);
  if (!(layerSpacing > EPS) || !Number.isFinite(layerSpacing)) {
    throw new VolumeBuildError(['无法确定层间距']);
  }

  for (let i = 1; i < axisStep.length; i += 1) {
    const delta = axisStep[i].t - axisStep[i - 1].t;
    const ratio = delta / layerSpacing;
    const integerRatio = Math.round(ratio);
    if (Math.abs(ratio - integerRatio) > 1e-3) {
      reasons.push(`第 ${axisStep[i - 1].index}→${axisStep[i].index} 层间距 ${delta.toFixed(3)}mm 不是基础间距 ${layerSpacing.toFixed(3)}mm 的整数倍，栅格不等距，无法组成完整体数据`);
    } else if (integerRatio >= 2) {
      for (let m = 1; m < integerRatio; m += 1) {
        reasons.push(`在第 ${axisStep[i - 1].index} 帧与第 ${axisStep[i].index} 帧之间缺片（缺少位置 t=${(axisStep[i - 1].t + m * layerSpacing).toFixed(3)}mm），切片序列不连续，无法组成完整体数据`);
      }
    }
  }
  if (reasons.length > 0) throw new VolumeBuildError(reasons);

  const firstFrame = frames[axisStep[0].index];
  const [colDir, rowDir] = firstFrame.imageOrientationPatient;
  // 切片轴方向：沿投影递增方向。允许与行×列反向（即翻转的层序）
  const layerDir = axisStep.length > 1
    ? (() => {
        const d = vecSub(frames[axisStep[1].index].imagePositionPatient, firstFrame.imagePositionPatient);
        const n = norm(d);
        return [d[0] / n, d[1] / n, d[2] / n] as const;
      })()
    : frameNormal;

  // 体素轴：i=沿列, j=沿行, k=沿切片；层序翻转时 layerDir 与法线反向（行列式可为 -1）
  const colUnit: Vec3 = [colDir[0], colDir[1], colDir[2]];
  const rowUnit: Vec3 = [rowDir[0], rowDir[1], rowDir[2]];
  const direction: Mat3 = makeMat3([colUnit, rowUnit, layerDir]);
  const spacing: [number, number, number] = [colSpacing, rowSpacing, layerSpacing];

  const dimensions: [number, number, number] = [cols, rows, frames.length];
  const data = new Float32Array(cols * rows * frames.length);
  for (let k = 0; k < axisStep.length; k += 1) {
    const frame = frames[axisStep[k].index];
    data.set(frame.pixelData, k * rows * cols);
  }

  const id = stableHash(
    `${label}|${dimensions.join('x')}|${spacing.map((s) => s.toFixed(4)).join(',')}|${direction.join(',')}|${firstFrame.imagePositionPatient.join(',')}`,
  );

  return {
    id,
    label,
    dimensions,
    spacing,
    direction,
    origin: [
      firstFrame.imagePositionPatient[0],
      firstFrame.imagePositionPatient[1],
      firstFrame.imagePositionPatient[2],
    ],
    data,
    window,
  };
}
