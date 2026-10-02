import type {
  ImageFrame,
  Measurement,
  MeasurementSliceBasis,
  SliceDecision,
  SliceSlot,
  Vec3,
  Volume,
} from './types';
import { buildVolumeFromSlots, type VolumeSlot } from './series';
import {
  cross,
  directionLabel,
  dot,
  EPS,
  mat3Column,
  norm,
  stableHash,
  worldToIjk,
} from './geometry';

export function frameContentHash(frame: Pick<ImageFrame, 'pixelData'>): string {
  const values: string[] = [];
  for (let i = 0; i < frame.pixelData.length; i += 1) {
    values.push(Number.isNaN(frame.pixelData[i]) ? 'NaN' : String(frame.pixelData[i]));
  }
  return stableHash(values.join('|'));
}

export function frameGeometryHash(frame: ImageFrame): string {
  return stableHash([
    frame.rows,
    frame.cols,
    frame.rowSpacing,
    frame.colSpacing,
    frame.imagePositionPatient.join(','),
    frame.imageOrientationPatient[0].join(','),
    frame.imageOrientationPatient[1].join(','),
  ].join('|'));
}

export function slotWithHashes(slot: SliceSlot, frame: ImageFrame | null): SliceSlot {
  if (!frame || slot.status === 'missing') {
    return { ...slot, contentHash: undefined, geometryHash: undefined };
  }
  return {
    ...slot,
    contentHash: frameContentHash(frame),
    geometryHash: frameGeometryHash(frame),
  };
}

// 测量实际经过的整数切片层：两个 k 端点之间的每层都属于依据，不只记录端点名/层号。
export function measurementBasisLayers(
  volume: Volume,
  m: Pick<Measurement, 'p1' | 'p2'>,
): MeasurementSliceBasis[] {
  const ijk1 = worldToIjk(m.p1, volume.origin, volume.direction, volume.spacing);
  const ijk2 = worldToIjk(m.p2, volume.origin, volume.direction, volume.spacing);
  const k1 = Math.round(ijk1[2]);
  const k2 = Math.round(ijk2[2]);
  const [from, to] = k1 <= k2 ? [k1, k2] : [k2, k1];
  const result: MeasurementSliceBasis[] = [];
  for (let layer = from; layer <= to; layer += 1) {
    const slot = volume.sliceManifest?.[layer];
    if (!slot || slot.status !== 'adopted' || !slot.contentHash) continue;
    result.push({
      t: slot.t,
      layer,
      contentHash: slot.contentHash,
      geometryHash: slot.geometryHash,
      sourceName: slot.sourceName,
      acquisition: slot.acquisition,
    });
  }
  return result.sort((a, b) => a.layer - b.layer);
}

export function expectedMeasurementLayerCount(
  volume: Volume,
  m: Pick<Measurement, 'p1' | 'p2'>,
): number {
  const ijk1 = worldToIjk(m.p1, volume.origin, volume.direction, volume.spacing);
  const ijk2 = worldToIjk(m.p2, volume.origin, volume.direction, volume.spacing);
  const from = Math.max(0, Math.round(Math.min(ijk1[2], ijk2[2])));
  const to = Math.min(volume.dimensions[2] - 1, Math.round(Math.max(ijk1[2], ijk2[2])));
  return Math.max(0, to - from + 1);
}

export function measurementBasisStillAdopted(
  volume: Volume,
  m: Pick<Measurement, 'p1' | 'p2' | 'basisLayers' | 'review'>,
): boolean {
  if (measurementRangeStatus(volume, m) !== 'valid') return false;
  const expected = measurementBasisLayers(volume, m);
  const saved = m.basisLayers ?? [];
  if (saved.length === 0 || saved.length !== expected.length) return false;
  return expected.every((slot, i) =>
    slot.layer === saved[i].layer &&
    Math.abs(slot.t - saved[i].t) <= 1e-6 &&
    slot.contentHash === saved[i].contentHash);
}

// 补片/替换片与现有体数据的关系分类
export type PatchKind =
  | 'fill-missing' // 正好填补一个缺片槽位
  | 'extend' // 超出当前范围的新增位置（沿栅格扩展）
  | 'replacement' // 与已采用切片同位置（重复位置），属替换候选
  | 'off-grid' // 不在栅格上的位置，无法落槽
  | 'conflict'; // 方向或尺寸与原体数据冲突

export interface PatchAssessment {
  sourceIndex: number; // 在本批次提供顺序中的位置
  sourceName: string;
  t: number; // 沿体数据切片轴的投影位置 (mm)
  kind: PatchKind;
  orientation: 'parallel' | 'opposite' | 'incompatible';
  conflicts: string[]; // 方向/尺寸/间距等逐条冲突说明
  targetLayer: number | null; // 落槽层号（extend 时可能 <0 或 >=nz）
  differs: boolean; // replacement：像素内容是否与当前已采用切片不同
  adoptable: boolean;
  defaultAdopt: boolean;
}

export interface PatchAnalysis {
  spacing: number; // 当前体数据层间距
  // 按空间位置升序排列（与补片到达顺序无关，最终排列唯一）
  assessments: PatchAssessment[];
  missingBefore: number[]; // 当前仍缺片的层号
  adoptableCount: number;
}

function frameName(frame: ImageFrame, index: number): string {
  return frame.sourceName ?? `补片第 ${index} 帧`;
}

function layerPixelsDiffer(volume: Volume, layer: number, frame: ImageFrame): boolean {
  const [nx, ny] = [volume.dimensions[0], volume.dimensions[1]];
  const offset = layer * nx * ny;
  for (let i = 0; i < nx * ny; i += 1) {
    const a = volume.data[offset + i];
    const b = frame.pixelData[i];
    if (Number.isNaN(a) && Number.isNaN(b)) continue;
    if (a !== b) return true;
  }
  return false;
}

// 只分析，不修改：同一批补片/替换片相对当前体数据的空间关系。
// 结果按空间位置排序，补片到达顺序不影响最终排列。
export function analyzePatch(volume: Volume, frames: ImageFrame[]): PatchAnalysis {
  const spacing = volume.spacing[2];
  const kDir = mat3Column(volume.direction, 2);
  const t0 = dot(volume.origin, kDir);
  const nz = volume.dimensions[2];
  const manifest = volume.sliceManifest ?? [];

  const assessments: PatchAssessment[] = frames.map((frame, index) => {
    const conflicts: string[] = [];
    const name = frameName(frame, index);

    // 方向关系：帧法线 vs 体数据切片轴
    const [colDir, rowDir] = frame.imageOrientationPatient;
    const n = cross(rowDir, colDir);
    const normalDot = dot(n, kDir);
    let orientation: PatchAssessment['orientation'] = 'parallel';
    if (norm(n) < EPS || Math.abs(normalDot) < 1 - 1e-3) {
      orientation = 'incompatible';
      conflicts.push(
        `${name}：方向 (${directionLabel(colDir)}/${directionLabel(rowDir)}) 与体数据切片轴 ${directionLabel(kDir)} 无法对齐`,
      );
    } else if (normalDot < 0) {
      orientation = 'opposite';
      conflicts.push(
        `${name}：平面方向与原体数据相反（法线指向 ${directionLabel(n)}，体数据切片轴为 ${directionLabel(kDir)}），属方向翻转冲突`,
      );
    }

    // 尺寸 / 像素间距
    if (frame.rows !== volume.dimensions[1] || frame.cols !== volume.dimensions[0]) {
      conflicts.push(
        `${name}：尺寸 ${frame.cols}x${frame.rows} 与原体数据 ${volume.dimensions[0]}x${volume.dimensions[1]} 不一致`,
      );
    }
    if (frame.pixelData.length !== frame.rows * frame.cols) {
      conflicts.push(`${name}：像素数 ${frame.pixelData.length} 与尺寸不符`);
    }
    if (Math.abs(frame.rowSpacing - volume.spacing[1]) > 1e-6 ||
        Math.abs(frame.colSpacing - volume.spacing[0]) > 1e-6) {
      conflicts.push(
        `${name}：像素间距 ${frame.colSpacing}/${frame.rowSpacing}mm 与原体数据 ${volume.spacing[0]}/${volume.spacing[1]}mm 不一致`,
      );
    }

    const t = dot(frame.imagePositionPatient, kDir);
    const u = (t - t0) / spacing;
    const nearest = Math.round(u);
    const onGrid = Math.abs(u - nearest) <= 1e-3;

    let kind: PatchKind;
    let targetLayer: number | null = null;
    let differs = false;
    if (conflicts.length > 0) {
      kind = 'conflict';
    } else if (!onGrid) {
      kind = 'off-grid';
      conflicts.push(
        `${name}：位置 t=${t.toFixed(3)}mm 不在层间距 ${spacing.toFixed(3)}mm 的栅格上（偏差 ${((u - nearest) * spacing).toFixed(3)}mm），无法落槽`,
      );
    } else if (nearest < 0 || nearest >= nz) {
      kind = 'extend';
      targetLayer = nearest;
    } else {
      targetLayer = nearest;
      const slot = manifest[nearest];
      if (slot && slot.status === 'missing') {
        kind = 'fill-missing';
      } else {
        kind = 'replacement';
        differs = layerPixelsDiffer(volume, nearest, frame);
      }
    }

    const adoptable = kind === 'fill-missing' || kind === 'extend' || kind === 'replacement';
    return {
      sourceIndex: index,
      sourceName: name,
      t,
      kind,
      orientation,
      conflicts,
      targetLayer,
      differs,
      adoptable,
      // 补片/扩展默认采用；替换候选默认保留原片（内容相同的替换采用无害，默认采用）
      defaultAdopt: kind === 'fill-missing' || kind === 'extend' ||
        (kind === 'replacement' && !differs),
    };
  });

  // 最终排列只取决于空间位置：按 t 升序排序，与到达顺序无关
  assessments.sort((a, b) => a.t - b.t || a.sourceIndex - b.sourceIndex);

  const missingBefore = manifest
    .filter((s) => s.status === 'missing')
    .map((s) => s.layer);

  return {
    spacing,
    assessments,
    missingBefore,
    adoptableCount: assessments.filter((a) => a.adoptable).length,
  };
}

export interface PatchApplyResult {
  volume: Volume; // 新体数据（数据集 id 保持不变）
  acquisitionId: string;
  changedLayers: number[]; // 新体数据中内容发生变化的层号
}

// 应用补片/替换片：choices 以 sourceIndex 为键，决定是否采用该帧。
// 纯函数：不修改传入的 volume，可先在预览中模拟、确认后再提交。
export function applyPatch(
  volume: Volume,
  frames: ImageFrame[],
  analysis: PatchAnalysis,
  choices: Record<number, boolean>,
  acquisitionLabel: string,
  arrivedAt = Date.now(),
): PatchApplyResult {
  const spacing = volume.spacing[2];
  const kDir = mat3Column(volume.direction, 2);
  const t0 = dot(volume.origin, kDir);
  const nz = volume.dimensions[2];
  const [nx, ny] = [volume.dimensions[0], volume.dimensions[1]];

  const prevManifest: SliceSlot[] = volume.sliceManifest ??
    Array.from({ length: nz }, (_, k) => ({
      t: t0 + k * spacing,
      layer: k,
      status: 'adopted' as const,
      sourceName: volume.importInfo?.sourceNames[k] ?? null,
      acquisition: volume.acquisitions?.[volume.acquisitions.length - 1]?.id ?? null,
    }));
  const prevAcquisitions = volume.acquisitions ?? [];
  const acquisitionId = volume.reviewState?.mergedFrom
    ? `merge-${Object.keys(volume.reviewState.branches).join('-')}-${prevAcquisitions.length + 1}`
    : `acq-${prevAcquisitions.length + 1}`;

  // 当前槽位 -> 帧（从现有体数据逐层取出，缺片层为 null）
  const slotFrames = new Map<number, { t: number; frame: ImageFrame | null; sourceName: string | null; acquisition: string | null; contentHash?: string; geometryHash?: string }>();
  const colDir = mat3Column(volume.direction, 0);
  const rowDir = mat3Column(volume.direction, 1);
  for (let k = 0; k < nz; k += 1) {
    const slot = prevManifest[k];
    const adopted = slot.status === 'adopted';
    slotFrames.set(k, {
      t: slot.t,
      frame: adopted
        ? {
            rows: ny,
            cols: nx,
            rowSpacing: volume.spacing[1],
            colSpacing: volume.spacing[0],
            imagePositionPatient: [
              volume.origin[0] + kDir[0] * spacing * k,
              volume.origin[1] + kDir[1] * spacing * k,
              volume.origin[2] + kDir[2] * spacing * k,
            ] as Vec3,
            imageOrientationPatient: [colDir, rowDir],
            pixelData: volume.data.subarray(k * nx * ny, (k + 1) * nx * ny),
            sourceName: slot.sourceName ?? undefined,
          }
        : null,
      sourceName: slot.sourceName,
      acquisition: slot.acquisition,
      contentHash: slot.contentHash,
      geometryHash: slot.geometryHash,
    });
  }

  const decisions: SliceDecision[] = [];
  const decidedAt = arrivedAt;

  // 落槽：只处理被用户采用且可采用的帧；按层号顺序处理保证确定性
  const adopted = analysis.assessments
    .filter((a) => a.adoptable && choices[a.sourceIndex])
    .sort((a, b) => (a.targetLayer ?? 0) - (b.targetLayer ?? 0));

  for (const a of adopted) {
    const frame = frames[a.sourceIndex];
    const layer = a.targetLayer!;
    const existing = slotFrames.get(layer);
    if (existing && existing.frame) {
      // 替换：记录被拒绝的原片
      decisions.push({
        t: a.t,
        layer,
        adopted: { sourceName: a.sourceName, acquisition: acquisitionId },
        rejected: existing.sourceName
          ? [{ sourceName: existing.sourceName, acquisition: existing.acquisition ?? '' }]
          : [],
        decidedAt,
      });
    } else {
      decisions.push({
        t: a.t,
        layer,
        adopted: { sourceName: a.sourceName, acquisition: acquisitionId },
        rejected: [],
        decidedAt,
      });
    }
    slotFrames.set(layer, {
      t: t0 + layer * spacing,
      frame,
      sourceName: a.sourceName,
      acquisition: acquisitionId,
      contentHash: frameContentHash(frame),
      geometryHash: frameGeometryHash(frame),
    });
  }

  // 被拒绝的替换候选也要留痕（每张切片的采用决定可回查）
  for (const a of analysis.assessments) {
    if (!a.adoptable || choices[a.sourceIndex]) continue;
    if (a.kind !== 'replacement') continue;
    const layer = a.targetLayer!;
    const slot = slotFrames.get(layer)!;
    decisions.push({
      t: a.t,
      layer,
      adopted: slot.sourceName
        ? { sourceName: slot.sourceName, acquisition: slot.acquisition ?? '' }
        : null,
      rejected: [{ sourceName: a.sourceName, acquisition: acquisitionId }],
      decidedAt,
    });
  }

  // 汇总槽位：原有 + 新增扩展层，按层号排序后重编号（最终排列与到达顺序无关）
  const allLayers = [...slotFrames.keys()].sort((a, b) => a - b);
  const minLayer = allLayers[0];
  const slots: VolumeSlot[] = allLayers.map((layer) => ({
    t: t0 + layer * spacing,
    frame: slotFrames.get(layer)!.frame,
  }));
  const newVolume = buildVolumeFromSlots(slots, volume.label, volume.window);

  const sliceManifest: SliceSlot[] = allLayers.map((layer, k) => {
    const entry = slotFrames.get(layer)!;
    return {
      t: t0 + layer * spacing,
      layer: k,
      status: entry.frame ? 'adopted' : 'missing',
      sourceName: entry.sourceName,
      acquisition: entry.frame ? entry.acquisition : null,
      contentHash: entry.frame ? entry.contentHash : undefined,
      geometryHash: entry.frame ? entry.geometryHash : undefined,
    };
  });

  // 内容变化的层（新体数据层号）：与旧体数据按空间位置对齐后逐层比较
  const changedLayers: number[] = [];
  const shift = -minLayer; // 旧层 k 在新体数据中的层号 = k + shift
  for (let k = 0; k < sliceManifest.length; k += 1) {
    const oldLayer = k - shift;
    const newSlot = sliceManifest[k];
    if (oldLayer < 0 || oldLayer >= nz) {
      changedLayers.push(k); // 新增扩展层
      continue;
    }
    const oldSlot = prevManifest[oldLayer];
    const oldMissing = oldSlot.status === 'missing';
    const newMissing = newSlot.status === 'missing';
    if (oldMissing !== newMissing) {
      changedLayers.push(k);
      continue;
    }
    if (newMissing) continue;
    const offset = k * nx * ny;
    const oldOffset = oldLayer * nx * ny;
    for (let i = 0; i < nx * ny; i += 1) {
      if (newVolume.data[offset + i] !== volume.data[oldOffset + i]) {
        changedLayers.push(k);
        break;
      }
    }
  }

  const next: Volume = {
    ...newVolume,
    id: volume.id, // 数据集 id 稳定：测量与浏览位置按 id 关联，补片不改变身份
    importInfo: volume.importInfo,
    sliceManifest,
    acquisitions: [
      ...prevAcquisitions,
      { id: acquisitionId, label: acquisitionLabel, kind: 'patch', arrivedAt },
    ],
    sliceDecisions: [...(volume.sliceDecisions ?? []), ...decisions],
    reviewState: volume.reviewState ? {
      ...volume.reviewState,
      resolutions: volume.reviewState.resolutions?.filter((r) => !changedLayers.includes(r.layer)),
      reopenedLayers: [
        ...(volume.reviewState.reopenedLayers ?? []).filter((layer) => !changedLayers.includes(layer)),
        ...changedLayers.filter((layer) =>
          volume.reviewState?.resolutions?.some((r) => r.layer === layer)),
      ],
    } : undefined,
  };
  return { volume: next, acquisitionId, changedLayers };
}

// 测量是否落在有效影像范围内：端点需在体数据范围内且不落在缺片层
export function measurementRangeStatus(
  volume: Volume,
  m: Pick<Measurement, 'p1' | 'p2'>,
): 'valid' | 'out-of-range' | 'on-missing' {
  const nz = volume.dimensions[2];
  for (const p of [m.p1, m.p2]) {
    const ijk = worldToIjk(p, volume.origin, volume.direction, volume.spacing);
    for (let axis = 0; axis < 3; axis += 1) {
      if (ijk[axis] < -0.5 || ijk[axis] > volume.dimensions[axis] - 0.5) {
        return 'out-of-range';
      }
    }
  }
  const k1 = Math.round(worldToIjk(m.p1, volume.origin, volume.direction, volume.spacing)[2]);
  const k2 = Math.round(worldToIjk(m.p2, volume.origin, volume.direction, volume.spacing)[2]);
  for (let k = Math.max(0, Math.min(k1, k2)); k <= Math.min(nz - 1, Math.max(k1, k2)); k += 1) {
    const slot = volume.sliceManifest?.[k];
    if (slot && slot.status === 'missing') return 'on-missing';
  }
  return 'valid';
}

// 测量是否受本次内容变化影响：任一端点落在变化层上即相关
export function measurementAffectedByLayers(
  volume: Volume,
  m: Pick<Measurement, 'p1' | 'p2'>,
  changedLayers: number[],
): boolean {
  if (changedLayers.length === 0) return false;
  const changed = new Set(changedLayers);
  for (const p of [m.p1, m.p2]) {
    const ijk = worldToIjk(p, volume.origin, volume.direction, volume.spacing);
    if (changed.has(Math.round(ijk[2]))) return true;
  }
  return false;
}
