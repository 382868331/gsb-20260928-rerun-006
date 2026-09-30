import type { ImageFrame, Mat3, Vec3, Volume } from './types';
import { VolumeBuildError, type ImportJudgment, type OrientationKind } from './types';
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

export interface FrameLayoutEntry {
  index: number;          // 输入（文件）序号
  t: number;              // 沿参考帧法线的投影位置(mm)
  inPlaneOffsetMm: number; // 帧原点相对参考栅格轴的面内偏移(mm)，非 0 即未共栅格
  orientation: OrientationKind;
  colDot: number;
  rowDot: number;
}

export interface FrameLayoutIssue {
  severity: 'error' | 'info';
  kind: 'orientation-opposite' | 'orientation-mirror' | 'orientation-inconsistent'
    | 'off-grid' | 'duplicate' | 'gap' | 'nonuniform' | 'ordering';
  message: string;
}

export interface FrameLayout {
  entries: FrameLayoutEntry[];          // 按空间位置 t 升序
  orderedInputIndices: number[];       // 空间层号 -> 输入序号
  orderMap: number[];                  // 输入序号 -> 空间层号
  layerSpacing: number | null;
  inputOrdering: ImportJudgment['inputOrdering'];
  fullStackFlipped: boolean;
  layerAxisLabel: string;
  planeLabels: [string, string];
  issues: FrameLayoutIssue[];
  judgment: ImportJudgment;
}

// 有符号方向比对：方向“相同”要求点积 ≈ +1；点积 ≈ -1 是方向相反，必须单独识别，绝不静默翻转
function classifyOrientation(
  frame: ImageFrame,
  baseColDir: Vec3,
  baseRowDir: Vec3,
): { kind: OrientationKind; colDot: number; rowDot: number } {
  const [colDir, rowDir] = frame.imageOrientationPatient;
  const colDot = dot(colDir, baseColDir);
  const rowDot = dot(rowDir, baseRowDir);
  const sameCol = colDot > 1 - 1e-3;
  const sameRow = rowDot > 1 - 1e-3;
  const oppCol = colDot < -(1 - 1e-3);
  const oppRow = rowDot < -(1 - 1e-3);
  if (sameCol && sameRow) return { kind: 'consistent', colDot, rowDot };
  if (oppCol && oppRow) return { kind: 'opposite', colDot, rowDot };
  if (oppCol && sameRow) return { kind: 'mirror-col', colDot, rowDot };
  if (sameCol && oppRow) return { kind: 'mirror-row', colDot, rowDot };
  return { kind: 'inconsistent', colDot, rowDot };
}

// 导入前的空间排列分析：只分析、不修改任何当前数据。
// 乱序、重复位置、缺片、方向相反（含混合批次）分别以独立条目说明。
export function analyzeFrames(frames: ImageFrame[]): FrameLayout {
  const issues: FrameLayoutIssue[] = [];
  const [baseColDir, baseRowDir] = frames[0].imageOrientationPatient;
  const normal = cross(baseRowDir, baseColDir);

  const projected: FrameLayoutEntry[] = frames.map((frame, index) => {
    const cls = classifyOrientation(frame, baseColDir, baseRowDir);
    const rel = vecSub(frame.imagePositionPatient, frames[0].imagePositionPatient);
    const inPlane = vecSub(rel, scaleVec(normal, dot(rel, normal)));
    return {
      index,
      t: dot(frame.imagePositionPatient, normal),
      inPlaneOffsetMm: norm(inPlane),
      orientation: cls.kind,
      colDot: cls.colDot,
      rowDot: cls.rowDot,
    };
  });

  // 面内偏移：切片原点不在同一栅格轴上，无法共栈
  for (const e of projected) {
    if (e.inPlaneOffsetMm > 1e-3) {
      issues.push({
        severity: 'error',
        kind: 'off-grid',
        message: `第 ${e.index} 帧原点相对参考栅格在面内偏移 ${e.inPlaneOffsetMm.toFixed(3)}mm，各切片不在同一组平行栅格线上，无法组成一致体数据`,
      });
    }
  }

  // 方向关系：相反 / 镜像 / 完全不一致逐帧说明（不做静默翻转）
  for (const e of projected) {
    const labels = `列方向点积=${e.colDot.toFixed(3)}、行方向点积=${e.rowDot.toFixed(3)}`;
    if (e.orientation === 'opposite') {
      issues.push({
        severity: 'error',
        kind: 'orientation-opposite',
        message: `第 ${e.index} 帧列/行方向与参考帧全部相反（${labels}），属于单帧方向翻转；与方向相反的其余切片混在同一批，不能靠翻转该帧掩盖冲突，无法组成一致体数据`,
      });
    } else if (e.orientation === 'mirror-col' || e.orientation === 'mirror-row') {
      issues.push({
        severity: 'error',
        kind: 'orientation-mirror',
        message: `第 ${e.index} 帧${e.orientation === 'mirror-col' ? '列方向' : '行方向'}与参考帧相反（${labels}），为镜像翻转切片，与其余切片方向关系冲突，无法组成一致体数据`,
      });
    } else if (e.orientation === 'inconsistent') {
      const [colDir, rowDir] = frames[e.index].imageOrientationPatient;
      issues.push({
        severity: 'error',
        kind: 'orientation-inconsistent',
        message: `第 ${e.index} 帧方向 (${directionLabel(colDir)}/${directionLabel(rowDir)}) 与参考帧 (${directionLabel(baseColDir)}/${directionLabel(baseRowDir)}) 不共栅格（${labels}），无法对齐到同一组平行切片`,
      });
    }
  }

  const entries = [...projected].sort((a, b) => a.t - b.t);

  // 输入顺序：递增 / 递减（整批翻转，合法）/ 乱序（需重排）
  const inputTs = projected.map((e) => e.t);
  let monotonicAsc = true;
  let monotonicDesc = true;
  for (let i = 1; i < inputTs.length; i += 1) {
    if (inputTs[i] <= inputTs[i - 1]) monotonicAsc = false;
    if (inputTs[i] >= inputTs[i - 1]) monotonicDesc = false;
  }
  const inputOrdering: ImportJudgment['inputOrdering'] = monotonicAsc
    ? 'ascending'
    : monotonicDesc
      ? 'descending'
      : 'shuffled';

  // 重复位置（按 t 分组报告）
  for (let i = 1; i < entries.length; i += 1) {
    if (!(entries[i].t - entries[i - 1].t > EPS)) {
      issues.push({
        severity: 'error',
        kind: 'duplicate',
        message: `第 ${entries[i - 1].index} 帧与第 ${entries[i].index} 帧空间位置重合（t=${entries[i].t.toFixed(3)}mm），存在重复切片，无法组成体数据`,
      });
    }
  }

  let layerSpacing: number | null = null;
  const gaps: number[] = [];
  for (let i = 1; i < entries.length; i += 1) {
    const d = entries[i].t - entries[i - 1].t;
    if (d > EPS) gaps.push(d);
  }
  if (gaps.length > 0) {
    layerSpacing = Math.min(...gaps);
    for (let i = 1; i < entries.length; i += 1) {
      const delta = entries[i].t - entries[i - 1].t;
      if (!(delta > EPS)) continue;
      const ratio = delta / (layerSpacing as number);
      const integerRatio = Math.round(ratio);
      if (Math.abs(ratio - integerRatio) > 1e-3) {
        issues.push({
          severity: 'error',
          kind: 'nonuniform',
          message: `空间顺序第 ${i - 1}→${i} 层（输入帧 ${entries[i - 1].index}→${entries[i].index}）间距 ${delta.toFixed(3)}mm 不是基础间距 ${(layerSpacing as number).toFixed(3)}mm 的整数倍，栅格不等距，无法组成完整体数据`,
        });
      } else if (integerRatio >= 2) {
        for (let m = 1; m < integerRatio; m += 1) {
          issues.push({
            severity: 'error',
            kind: 'gap',
            message: `输入帧 ${entries[i - 1].index} 与第 ${entries[i].index} 帧之间缺片：缺少位置 t=${(entries[i - 1].t + m * (layerSpacing as number)).toFixed(3)}mm（间隔 ${integerRatio} 个基础层距，缺 ${integerRatio - 1} 片），切片序列不连续，无法组成完整体数据`,
          });
        }
      }
    }
  }

  // 整批翻转：输入顺序递减且各帧方向一致——这是合法的层序翻转，仅提示，不是错误
  const fullStackFlipped = inputOrdering === 'descending';
  if (inputOrdering === 'shuffled') {
    issues.push({
      severity: 'info',
      kind: 'ordering',
      message: `输入顺序沿切片轴乱序：将按患者坐标空间位置重新排序后组卷（重排不改变任何空间测量）`,
    });
  } else if (fullStackFlipped) {
    issues.push({
      severity: 'info',
      kind: 'ordering',
      message: `整批切片为反向层序（输入顺序沿 ${directionLabel(normal)} 轴递减）：这是方向一致的整体翻转，将以 ${directionLabel(scaleVec(normal, -1))}→${directionLabel(normal)} 的空间顺序组卷，无需也不会翻转任何单帧`,
    });
  }

  const orderedInputIndices = entries.map((e) => e.index);
  const orderMap: number[] = new Array(frames.length).fill(-1);
  orderedInputIndices.forEach((inputIndex, layer) => { orderMap[inputIndex] = layer; });
  const layerAxisLabel = `${directionLabel(scaleVec(normal, -1))}→${directionLabel(normal)}`;

  const judgment: ImportJudgment = {
    frameCount: frames.length,
    layerSpacingMm: layerSpacing === null ? null : Number(layerSpacing.toFixed(6)),
    inputOrdering,
    orderMap,
    reordered: inputOrdering !== 'ascending',
    fullStackFlipped,
    layerAxisLabel,
    planeLabels: [directionLabel(baseColDir), directionLabel(baseRowDir)],
  };

  return {
    entries,
    orderedInputIndices,
    orderMap,
    layerSpacing,
    inputOrdering,
    fullStackFlipped,
    layerAxisLabel,
    planeLabels: [directionLabel(baseColDir), directionLabel(baseRowDir)],
    issues,
    judgment,
  };
}

function scaleVec(v: Vec3, s: number): Vec3 {
  return [v[0] * s, v[1] * s, v[2] * s];
}

// 把一组 2D 影像帧组装成完整体数据；任何缺片或方向冲突都会抛出原因列表。
export function buildVolumeFromFrames(
  frames: ImageFrame[],
  label: string,
  window: Volume['window'],
  importInfo?: Volume['importInfo'],
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

  // 空间排列分析：乱序/重复位置/缺片/方向相反分别给出；致命冲突直接抛出
  const layout = analyzeFrames(frames);
  const fatal = layout.issues.filter((iss) => iss.severity === 'error');
  if (fatal.length > 0) throw new VolumeBuildError(fatal.map((iss) => iss.message));

  const firstFrame = frames[layout.orderedInputIndices[0]];
  const [colDir, rowDir] = firstFrame.imageOrientationPatient;
  // 切片轴方向：沿投影递增方向。允许与行×列反向（即翻转的层序）
  const layerDir = layout.orderedInputIndices.length > 1
    ? (() => {
        const d = vecSub(
          frames[layout.orderedInputIndices[1]].imagePositionPatient,
          firstFrame.imagePositionPatient,
        );
        const n = norm(d);
        return [d[0] / n, d[1] / n, d[2] / n] as const;
      })()
    : cross(frames[0].imageOrientationPatient[1], frames[0].imageOrientationPatient[0]);

  // 体素轴：i=沿列, j=沿行, k=沿切片；层序翻转时 layerDir 与法线反向（行列式可为 -1）
  const colUnit: Vec3 = [colDir[0], colDir[1], colDir[2]];
  const rowUnit: Vec3 = [rowDir[0], rowDir[1], rowDir[2]];
  const direction: Mat3 = makeMat3([colUnit, rowUnit, layerDir]);
  const spacing: [number, number, number] = [colSpacing, rowSpacing, layout.layerSpacing as number];

  const dimensions: [number, number, number] = [cols, rows, frames.length];
  const data = new Float32Array(cols * rows * frames.length);
  for (let k = 0; k < layout.orderedInputIndices.length; k += 1) {
    const frame = frames[layout.orderedInputIndices[k]];
    data.set(frame.pixelData, k * rows * cols);
  }

  const id = stableHash(
    // id 只由几何（尺寸/间距/方向/原点）决定：乱序重排或保存重开重建时 id 稳定，测量与浏览位置才能找回；label 不参与
    `${dimensions.join('x')}|${spacing.map((s) => s.toFixed(4)).join(',')}|${direction.join(',')}|${firstFrame.imagePositionPatient.join(',')}`,
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
    importInfo,
  };
}
