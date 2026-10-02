import type {
  ImageFrame,
  Measurement,
  ReviewBranch,
  SliceSlot,
  Vec3,
  Volume,
} from './types';
import { buildVolumeFromSlots } from './series';
import {
  frameContentHash,
  frameGeometryHash,
  measurementBasisLayers,
  measurementBasisStillAdopted,
} from './patch';
import { dot, mat3Column } from './geometry';

export type MergeItemStatus =
  | 'identical-adopted'
  | 'same-missing'
  | 'same-content-duplicate'
  | 'only-a'
  | 'only-b'
  | 'content-conflict'
  | 'geometry-conflict'
  | 'a-missing-b-adopted'
  | 'b-missing-a-adopted';

export interface MergeLayerItem {
  layer: number;
  t: number;
  status: MergeItemStatus;
  a: SliceSlot | null;
  b: SliceSlot | null;
  autoResolved: boolean;
  resolution: 'a' | 'b' | null;
  conflicting: boolean;
  reasons: string[];
}

export interface MergeAnalysis {
  items: MergeLayerItem[];
  unresolvedLayers: number[];
  geometryConflicts: number[];
}

export interface MergeReviewOptions {
  label?: string;
  resolutions?: Record<number, 'a' | 'b'>;
  mergedAt?: number;
}

export interface MergeReviewResult {
  volume: Volume;
  measurements: Measurement[];
  analysis: MergeAnalysis;
}

function frameForLayer(volume: Volume, layer: number): ImageFrame | null {
  const slot = volume.sliceManifest?.[layer];
  if (!slot || slot.status === 'missing') return null;
  const [nx, ny] = volume.dimensions;
  const kDir = mat3Column(volume.direction, 2);
  const colDir = mat3Column(volume.direction, 0);
  const rowDir = mat3Column(volume.direction, 1);
  const position: Vec3 = [
    volume.origin[0] + kDir[0] * volume.spacing[2] * layer,
    volume.origin[1] + kDir[1] * volume.spacing[2] * layer,
    volume.origin[2] + kDir[2] * volume.spacing[2] * layer,
  ];
  return {
    rows: ny,
    cols: nx,
    rowSpacing: volume.spacing[1],
    colSpacing: volume.spacing[0],
    imagePositionPatient: position,
    imageOrientationPatient: [colDir, rowDir],
    pixelData: volume.data.subarray(layer * nx * ny, (layer + 1) * nx * ny),
    sourceName: slot.sourceName ?? undefined,
  };
}

function sameGeometry(a?: SliceSlot | null, b?: SliceSlot | null): boolean {
  return !!a?.geometryHash && !!b?.geometryHash && a.geometryHash === b.geometryHash;
}

function explain(status: MergeItemStatus, a: SliceSlot | null, b: SliceSlot | null): string[] {
  const an = a?.sourceName ?? '缺片';
  const bn = b?.sourceName ?? '缺片';
  switch (status) {
    case 'identical-adopted': return [`双方采用决定一致，且像素内容指纹一致（${an}）`];
    case 'same-missing': return ['双方均保留缺片，合并后仍为不确定缺片层'];
    case 'same-content-duplicate': return [`同一像素内容被重复导入（${an} / ${bn}），只保留一份`];
    case 'only-a': return ['仅审阅 A 覆盖该位置'];
    case 'only-b': return ['仅审阅 B 覆盖该位置'];
    case 'a-missing-b-adopted': return ['A 仍缺片，B 已补入该层'];
    case 'b-missing-a-adopted': return ['B 仍缺片，A 已补入该层'];
    case 'content-conflict': return ['同一空间位置存在不同像素内容，必须显式选边'];
    case 'geometry-conflict': return ['方向、尺寸或位置几何不一致，不能按导入顺序决定胜者'];
  }
}

function classify(a: SliceSlot | null, b: SliceSlot | null): Omit<MergeLayerItem, 'layer' | 't' | 'a' | 'b'> {
  const aAdopted = !!a && a.status === 'adopted';
  const bAdopted = !!b && b.status === 'adopted';
  let status: MergeItemStatus;
  let autoResolved = false;
  let resolution: 'a' | 'b' | null = null;
  const sameInitialDecision = !!a && !!b &&
    a.acquisition === 'acq-1' &&
    b.acquisition === 'acq-1' &&
    a.sourceName === b.sourceName;

  if (!a && !b) status = 'same-missing';
  else if (!a) {
    status = 'only-b';
    autoResolved = bAdopted;
    resolution = bAdopted ? 'b' : null;
  } else if (!b) {
    status = 'only-a';
    autoResolved = aAdopted;
    resolution = aAdopted ? 'a' : null;
  } else if (!aAdopted && !bAdopted) {
    status = 'same-missing';
  } else if (!aAdopted) {
    status = 'a-missing-b-adopted';
    autoResolved = true;
    resolution = 'b';
  } else if (!bAdopted) {
    status = 'b-missing-a-adopted';
    autoResolved = true;
    resolution = 'a';
  } else if (!sameGeometry(a, b)) {
    status = 'geometry-conflict';
  } else if (a.contentHash === b.contentHash) {
    status = sameInitialDecision
      ? 'identical-adopted'
      : 'same-content-duplicate';
    autoResolved = true;
    resolution = 'a';
  } else {
    status = 'content-conflict';
  }

  const conflicting = status === 'content-conflict' || status === 'geometry-conflict';
  return {
    status,
    autoResolved,
    resolution: conflicting ? null : resolution,
    conflicting,
    reasons: explain(status, a, b),
  };
}

export function analyzeReviewMerge(a: Volume, b: Volume): MergeAnalysis {
  const items: MergeLayerItem[] = [];
  const count = Math.max(a.dimensions[2], b.dimensions[2]);
  const ref = a;
  const spacing = ref.spacing[2];
  const t0 = dot(ref.origin, mat3Column(ref.direction, 2));

  for (let layer = 0; layer < count; layer += 1) {
    const slotA = a.sliceManifest?.[layer] ?? null;
    const slotB = b.sliceManifest?.[layer] ?? null;
    items.push({ layer, t: t0 + layer * spacing, a: slotA, b: slotB, ...classify(slotA, slotB) });
  }
  return {
    items,
    unresolvedLayers: items.filter((i) => i.conflicting).map((i) => i.layer),
    geometryConflicts: items.filter((i) => i.status === 'geometry-conflict').map((i) => i.layer),
  };
}

export function previewReviewMerge(
  a: Volume,
  b: Volume,
  resolutions: Record<number, 'a' | 'b'> = {},
): MergeAnalysis {
  const base = analyzeReviewMerge(a, b);
  return {
    ...base,
    items: base.items.map((item) => {
      if (!item.conflicting) return item;
      const choice = resolutions[item.layer];
      return choice ? { ...item, resolution: choice } : { ...item, resolution: null };
    }),
    unresolvedLayers: base.items
      .filter((i) => i.conflicting && !resolutions[i.layer])
      .map((i) => i.layer),
    geometryConflicts: base.geometryConflicts,
  };
}

function adoptedSlot(volume: Volume, item: MergeLayerItem, side: 'a' | 'b'): SliceSlot | null {
  const slot = side === 'a' ? item.a : item.b;
  if (!slot || slot.status !== 'adopted') return null;
  if (volume.dimensions[2] <= item.layer) return null;
  return slot;
}

export function mergeReviews(
  branchA: ReviewBranch,
  branchB: ReviewBranch,
  options: MergeReviewOptions = {},
): MergeReviewResult {
  const a = branchA.volume;
  const b = branchB.volume;
  const analysis = previewReviewMerge(a, b, options.resolutions);
  const slots = analysis.items.map((item) => ({
    t: item.t,
    frame:
      item.resolution === 'b'
        ? frameForLayer(b, item.layer)
        : item.resolution === 'a'
          ? frameForLayer(a, item.layer)
          : null,
  }));
  const merged = buildVolumeFromSlots(slots, options.label ?? `合并：${branchA.label} + ${branchB.label}`, a.window);
  const resolvedAt = options.mergedAt ?? Date.now();
  merged.sliceManifest = analysis.items.map((item, k) => {
    const side = item.resolution;
    const source = side === 'b' ? adoptedSlot(b, item, 'b') : side === 'a' ? adoptedSlot(a, item, 'a') : null;
    return {
      t: item.t,
      layer: k,
      status: source ? 'adopted' : 'missing',
      sourceName: source?.sourceName ?? null,
      acquisition: source?.acquisition ?? null,
      contentHash: source?.contentHash,
      geometryHash: source?.geometryHash,
    };
  });
  merged.acquisitions = Array.from(new Map(
    [...(a.acquisitions ?? []), ...(b.acquisitions ?? [])].map((acq) => [acq.id, acq]),
  ).values()).sort((x, y) => x.id.localeCompare(y.id));
  merged.reviewState = {
    baseAcquisitionId: branchA.baseAcquisitionId,
    branches: {
      [branchA.id]: {
        id: branchA.id,
        label: branchA.label,
        baseAcquisitionId: branchA.baseAcquisitionId,
        measurements: branchA.measurements,
        createdAt: branchA.createdAt,
      },
      [branchB.id]: {
        id: branchB.id,
        label: branchB.label,
        baseAcquisitionId: branchB.baseAcquisitionId,
        measurements: branchB.measurements,
        createdAt: branchB.createdAt,
      },
    },
    mergedFrom: { reviewIds: [branchA.id, branchB.id], mergedAt: resolvedAt },
    resolutions: analysis.items
      .filter((item) => item.resolution)
      .map((item) => ({
        layer: item.layer,
        reviewId: item.resolution === 'b' ? branchB.id : branchA.id,
        contentHash: (item.resolution === 'b' ? item.b?.contentHash : item.a?.contentHash) ?? '',
        decidedAt: resolvedAt,
      })),
  };

  const carryMeasurements = (measurements: Measurement[], reviewId: string): Measurement[] =>
    measurements.map((measurement) => {
      const reusable = measurementBasisStillAdopted(merged, measurement);
      const basisLayers = reusable ? measurementBasisLayers(merged, measurement) : measurement.basisLayers;
      return {
        ...measurement,
        id: `${reviewId}:${measurement.id}`,
        sourceReviewId: reviewId,
        basisLayers,
        review: reusable ? 'confirmed' : 'pending',
      };
    });

  return {
    volume: merged,
    measurements: [
      ...carryMeasurements(branchA.measurements, branchA.id),
      ...carryMeasurements(branchB.measurements, branchB.id),
    ],
    analysis,
  };
}

export function withdrawMergeResolution(
  volume: Volume,
  measurements: Measurement[],
  layer: number,
): { volume: Volume; measurements: Measurement[] } {
  const next = {
    ...volume,
    data: Float32Array.from(volume.data),
    sliceManifest: volume.sliceManifest?.map((slot) =>
      slot.layer === layer
        ? { ...slot, status: 'missing' as const, sourceName: null, acquisition: null, contentHash: undefined, geometryHash: undefined }
        : slot),
  };
  const [nx, ny] = [next.dimensions[0], next.dimensions[1]];
  next.data.fill(NaN, layer * nx * ny, (layer + 1) * nx * ny);
  next.reviewState = {
    ...next.reviewState!,
    resolutions: next.reviewState?.resolutions?.filter((r) => r.layer !== layer),
    withdrawnResolutions: [
      ...(next.reviewState?.withdrawnResolutions ?? []),
      ...(next.reviewState?.resolutions?.filter((r) => r.layer === layer) ?? []),
    ],
    withdrawnLayers: Array.from(new Set([...(next.reviewState?.withdrawnLayers ?? []), layer])).sort((a, b) => a - b),
  };
  return {
    volume: next,
    measurements: measurements.map((m) =>
      m.basisLayers?.some((b) => b.layer === layer)
        ? { ...m, review: 'pending' as const }
        : m),
  };
}

export function measurementUsesSlices(measurement: Measurement, volume: Volume): number[] {
  const current = measurementBasisLayers(volume, measurement).map((b) => b.layer);
  const saved = (measurement.basisLayers ?? []).map((b) => b.layer);
  return Array.from(new Set([...saved, ...current])).sort((a, b) => a - b);
}

export function frameHashesForVolume(volume: Volume): Array<{ layer: number; contentHash: string; geometryHash: string }> {
  return (volume.sliceManifest ?? []).map((slot, layer) => {
    const frame = frameForLayer(volume, layer);
    return {
      layer,
      contentHash: slot.contentHash ?? (frame ? frameContentHash(frame) : ''),
      geometryHash: slot.geometryHash ?? (frame ? frameGeometryHash(frame) : ''),
    };
  });
}
