import type { ImageFrame, ImportInfo, Volume } from './types';
import { buildVolumeFromFrames } from './series';
import { cross, directionLabel, dot, EPS, norm } from './geometry';

function basicFrameReasons(frames: ImageFrame[]): string[] {
  const reasons: string[] = [];
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
    if (Math.abs(norm(colDir) - 1) >= 1e-3 || Math.abs(norm(rowDir) - 1) >= 1e-3) {
      reasons.push(`第 ${f} 帧方向余弦不是单位向量`);
    }
    if (Math.abs(dot(colDir, rowDir)) > 1e-3) {
      reasons.push(`第 ${f} 帧行/列方向不垂直`);
    }
  }
  return reasons;
}

// 一列切片沿切片轴的空间排列信息
export interface SlicePlacement {
  sourceIndex: number; // 在导入提供顺序中的位置（0 起）
  sourceName: string;
  t: number; // 沿参考切片轴法线的投影位置 (mm)
  layer: number; // 排序后的层号（去重/缺片仍给整数槽位，可能与帧不一一对应）
  // 帧平面法线与参考法线的关系：parallel=同向，opposite=法线反向，incompatible=无法对齐
  orientation: 'parallel' | 'opposite' | 'incompatible';
}

export interface ImportAnalysis {
  frameCount: number;
  layerSpacing: number | null;
  // 按空间位置升序排列的切片
  placements: SlicePlacement[];
  // 按原始提供顺序排列的切片（预览上排）
  sourceSequence: SlicePlacement[];
  // 参考栅格方向标签（排序方向）
  layerDirectionLabel: string;
  // 原始提供顺序沿切片轴的方向标签（如 S→I 则 sourceDirectionLabel='S'）
  sourceDirectionLabel: string | null;
  reversedOrder: boolean; // 整批层序翻转（合法：仅顺序与空间序相反）
  shuffled: boolean; // 存在乱序帧（合法重排，但需在预览中说明）
  outOfOrderPairs: Array<[number, number]>; // 提供顺序中位置错位的帧对（源索引）
  // 非致命说明（乱序、整批翻转），仍可组卷
  warnings: string[];
  // 致命冲突：方向相反/无法对齐、重复位置、缺片、栅格不等距等
  reasons: string[];
  ok: boolean;
}

function frameName(frame: ImageFrame, index: number): string {
  return (frame as { sourceName?: string }).sourceName ?? `第 ${index} 帧`;
}

// 只做几何/栅格分析，不抛异常；调用方据此渲染“导入前空间排列预览”。
export function analyzeFrameImport(
  frames: ImageFrame[],
  sourceNames?: string[],
): ImportAnalysis {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const placements: SlicePlacement[] = [];
  const outOfOrderPairs: Array<[number, number]> = [];

  const empty = frames.length === 0;
  const tooFew = frames.length < 2;
  if (empty) reasons.push('序列为空：没有任何影像帧');
  if (!empty && tooFew) reasons.push('切片数量不足：至少需要 2 帧才能确定层间距');
  if (empty || tooFew) {
    return {
      frameCount: frames.length,
      layerSpacing: null,
      placements: [],
      sourceSequence: [],
      layerDirectionLabel: '',
      sourceDirectionLabel: null,
      reversedOrder: false,
      shuffled: false,
      outOfOrderPairs: [],
      warnings,
      reasons,
      ok: false,
    };
  }
  reasons.push(...basicFrameReasons(frames));

  // 参考几何来自第 0 帧（DICOM 场景通常以首帧方位为基准）
  const [baseCol, baseRow] = frames[0].imageOrientationPatient;
  const baseNormal = cross(baseRow, baseCol);

  for (let f = 0; f < frames.length; f += 1) {
    const [colDir, rowDir] = frames[f].imageOrientationPatient;
    const n = cross(rowDir, colDir);
    const normalDot = dot(n, baseNormal);
    let orientation: SlicePlacement['orientation'] = 'parallel';
    if (norm(n) < EPS) {
      orientation = 'incompatible';
    } else if (Math.abs(normalDot) < 1 - 1e-3) {
      orientation = 'incompatible';
    } else if (normalDot < 0) {
      orientation = 'opposite';
    }
    placements.push({
      sourceIndex: f,
      sourceName: sourceNames?.[f] ?? frameName(frames[f], f),
      t: dot(frames[f].imagePositionPatient, baseNormal),
      layer: -1,
      orientation,
    });

    if (orientation === 'opposite') {
      reasons.push(
        `第 ${f} 帧（${frameName(frames[f], f)}）平面方向与首帧相反（法线指向 ${directionLabel(n)}，首帧为 ${directionLabel(baseNormal)}）：属方向翻转冲突，不能当作方向一致的平行切片，已停止静默翻转`,
      );
    } else if (orientation === 'incompatible') {
      reasons.push(
        `第 ${f} 帧（${frameName(frames[f], f)}）方向 (${directionLabel(colDir)}/${directionLabel(rowDir)}) 与首帧冲突，无法对齐到同一栅格`,
      );
    }
  }

  // 按沿参考法线投影排序（只重排位置，绝不翻转像素）
  const sorted = [...placements].sort((a, b) => a.t - b.t);

  // 乱序：提供顺序与空间升序不一致；整批严格反向属于“层序翻转”，单独识别
  const ascending = sorted.every((p, i) => p.sourceIndex === i);
  let reversed = true;
  for (let i = 0; i < sorted.length; i += 1) {
    if (sorted[i].sourceIndex !== sorted.length - 1 - i) { reversed = false; break; }
  }
  // 严格整批反向属“层序翻转”，不算乱序；部分错位才是乱序
  const shuffled = !ascending && !reversed;
  if (!ascending) {
    for (let i = 1; i < placements.length; i += 1) {
      if (placements[i].t < placements[i - 1].t - EPS) {
        outOfOrderPairs.push([placements[i - 1].sourceIndex, placements[i].sourceIndex]);
      }
    }
  }

  // 重复位置
  let layerSpacing = Infinity;
  const duplicateGroups = new Map<string, number[]>();
  for (const p of sorted) {
    const key = p.t.toFixed(4);
    const group = duplicateGroups.get(key);
    if (group) group.push(p.sourceIndex);
    else duplicateGroups.set(key, [p.sourceIndex]);
  }
  for (const group of duplicateGroups.values()) {
    if (group.length > 1) {
      reasons.push(
        `重复位置：第 ${group.join('、')} 帧位于同一空间位置 t=${sorted.find((p) => p.sourceIndex === group[0])!.t.toFixed(3)}mm，同一层出现多张切片`,
      );
    }
  }
  for (let i = 1; i < sorted.length; i += 1) {
    const delta = sorted[i].t - sorted[i - 1].t;
    if (delta > EPS) layerSpacing = Math.min(layerSpacing, delta);
  }

  // 缺片 / 栅格不等距
  if (Number.isFinite(layerSpacing) && layerSpacing > EPS) {
    for (let i = 1; i < sorted.length; i += 1) {
      const delta = sorted[i].t - sorted[i - 1].t;
      if (!(delta > EPS)) continue;
      const ratio = delta / layerSpacing;
      const integerRatio = Math.round(ratio);
      if (Math.abs(ratio - integerRatio) > 1e-3) {
        reasons.push(
          `第 ${sorted[i - 1].sourceIndex}→${sorted[i].sourceIndex} 帧间距 ${delta.toFixed(3)}mm 不是基础间距 ${layerSpacing.toFixed(3)}mm 的整数倍，栅格不等距，无法组成完整体数据`,
        );
      } else if (integerRatio >= 2) {
        for (let m = 1; m < integerRatio; m += 1) {
          reasons.push(
            `缺片：第 ${sorted[i - 1].sourceIndex} 帧与第 ${sorted[i].sourceIndex} 帧之间缺少位置 t=${(sorted[i - 1].t + m * layerSpacing).toFixed(3)}mm 的切片`,
          );
        }
      }
    }
    sorted.forEach((p, i) => { p.layer = i; });
  } else {
    layerSpacing = NaN;
  }

  // 提供顺序的走向（首帧→第二帧的位移方向）
  let sourceDirectionLabel: string | null = null;
  if (frames.length >= 2) {
    const delta = [
      frames[1].imagePositionPatient[0] - frames[0].imagePositionPatient[0],
      frames[1].imagePositionPatient[1] - frames[0].imagePositionPatient[1],
      frames[1].imagePositionPatient[2] - frames[0].imagePositionPatient[2],
    ] as const;
    if (norm(delta) > EPS) sourceDirectionLabel = directionLabel(delta);
  }
  const layerDirectionLabel = directionLabel(baseNormal);

  if (reversed && !reasons.some((r) => r.includes('方向'))) {
    warnings.push(
      `整批切片为层序翻转（提供顺序沿 ${sourceDirectionLabel ?? '?'} 方向，空间升序沿 ${layerDirectionLabel} 方向）：这是合法的方向翻转，确认后将按空间位置反向重排，不修改任何像素`,
    );
  }
  if (shuffled) {
    const detail = outOfOrderPairs
      .slice(0, 4)
      .map(([a, b]) => `第 ${a} 帧位于第 ${b} 帧之后`)
      .join('；');
    warnings.push(
      `乱序：提供顺序与空间顺序不一致（${detail || '存在前后错位帧'}），确认后将按空间位置重新排序`,
    );
  }

  return {
    frameCount: frames.length,
    layerSpacing: Number.isFinite(layerSpacing) ? layerSpacing : null,
    placements: sorted,
    sourceSequence: placements,
    layerDirectionLabel,
    sourceDirectionLabel,
    reversedOrder: reversed,
    shuffled,
    outOfOrderPairs,
    warnings,
    reasons,
    ok: reasons.length === 0,
  };
}

// 分析通过后执行真正组卷，并把导入判定与原始来源写入 volume.importInfo。
// 分析未通过（ok=false）时调用会抛出 VolumeBuildError，且不应替换当前数据。
export function buildVolumeFromAnalysis(
  frames: ImageFrame[],
  label: string,
  window: Volume['window'],
  analysis: ImportAnalysis,
  sourceNames?: string[],
): Volume {
  const volume = buildVolumeFromFrames(frames, label, window);
  const importInfo: ImportInfo = {
    sourceOrder: analysis.placements.map((p) => p.sourceIndex),
    frameCount: analysis.frameCount,
    sourceDirectionLabel: analysis.sourceDirectionLabel ?? '',
    layerDirectionLabel: analysis.layerDirectionLabel,
    reversedOrder: analysis.reversedOrder,
    shuffled: analysis.shuffled,
    sourceNames:
      sourceNames ?? frames.map((_, i) => frameName(frames[i], i)),
  };
  return { ...volume, importInfo };
}
