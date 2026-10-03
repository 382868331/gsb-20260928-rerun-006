import type { ImageFrame, Measurement, SliceSlot, Vec3, Volume } from './types';
import { buildVolumeFromSlots } from './series';
import { dot, mat3Column, worldToIjk } from './geometry';

export type ReviewSide = 'a' | 'b';
export type MergeLayerStatus =
  | 'agreement'
  | 'duplicate'
  | 'content-conflict'
  | 'unilateral'
  | 'missing-agreement'
  | 'geometry-conflict';

export interface LayerContent {
  side: ReviewSide;
  sourceName: string;
  acquisition: string | null;
  hash: string;
  frame: ImageFrame;
}

export interface MergeLayer {
  layer: number;
  t: number;
  status: MergeLayerStatus;
  a: LayerContent | null;
  b: LayerContent | null;
  selected: ReviewSide | null;
  required: boolean;
  reason: string;
}

export interface ReviewMergeAnalysis {
  layers: MergeLayer[];
  spacing: number;
  unresolvedLayers: number[];
  geometryErrors: string[];
}

export interface MeasurementSliceBasis {
  layer: number;
  sourceName: string | null;
  acquisition: string | null;
  hash: string;
}

export interface MeasurementMergeResult {
  measurement: Measurement;
  origin: ReviewSide;
  reusable: boolean;
  missingBasis: number[];
  changedBasis: number[];
}

const layerCache = new WeakMap<Volume, Map<number, LayerContent>>();

export function contentHash(pixels: ArrayLike<number>): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  const buffer = new ArrayBuffer(4);
  const f32 = new Float32Array(buffer);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < pixels.length; i += 1) {
    f32[0] = Number.isNaN(pixels[i]) ? Number.NaN : Math.fround(pixels[i]);
    for (let byteIndex = 0; byteIndex < 4; byteIndex += 1) {
      h1 = Math.imul(h1 ^ bytes[byteIndex], 2654435761);
      h2 = Math.imul(h2 ^ bytes[byteIndex], 1597334677);
    }
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `px-${pixels.length}-${(h2 >>> 0).toString(16).padStart(8, '0')}${(h1 >>> 0).toString(16).padStart(8, '0')}`;
}

function positionForLayer(volume: Volume, layer: number): Vec3 {
  const kDir = mat3Column(volume.direction, 2);
  return [
    volume.origin[0] + kDir[0] * volume.spacing[2] * layer,
    volume.origin[1] + kDir[1] * volume.spacing[2] * layer,
    volume.origin[2] + kDir[2] * volume.spacing[2] * layer,
  ];
}

function frameForLayer(volume: Volume, layer: number): ImageFrame | null {
  const slot = volume.sliceManifest?.[layer];
  if (!slot || slot.status !== 'adopted') return null;
  const [nx, ny] = volume.dimensions;
  return {
    rows: ny,
    cols: nx,
    rowSpacing: volume.spacing[1],
    colSpacing: volume.spacing[0],
    imagePositionPatient: positionForLayer(volume, layer),
    imageOrientationPatient: [mat3Column(volume.direction, 0), mat3Column(volume.direction, 1)],
    pixelData: volume.data.subarray(layer * nx * ny, (layer + 1) * nx * ny),
    sourceName: slot.sourceName ?? undefined,
  };
}

export function layerContent(volume: Volume, layer: number): LayerContent | null {
  let map = layerCache.get(volume);
  if (!map) {
    map = new Map();
    layerCache.set(volume, map);
  }
  const cached = map.get(layer);
  if (cached) return cached;
  const slot = volume.sliceManifest?.[layer];
  if (!slot || slot.status !== 'adopted') return null;
  const frame = frameForLayer(volume, layer);
  if (!frame) return null;
  const content: LayerContent = {
    side: 'a',
    sourceName: slot.sourceName ?? '',
    acquisition: slot.acquisition,
    hash: contentHash(frame.pixelData),
    frame,
  };
  map.set(layer, content);
  return content;
}

function sameGeometry(a: Volume, b: Volume): string[] {
  const errors: string[] = [];
  if (a.dimensions[0] !== b.dimensions[0] || a.dimensions[1] !== b.dimensions[1]) {
    errors.push(`尺寸不一致：${a.dimensions[0]}×${a.dimensions[1]} vs ${b.dimensions[0]}×${b.dimensions[1]}`);
  }
  for (let i = 0; i < 3; i += 1) {
    if (Math.abs(a.spacing[i] - b.spacing[i]) > 1e-6) errors.push(`体素间距第 ${i + 1} 轴不一致`);
    if (Math.abs(a.origin[i] - b.origin[i]) > 1e-6) errors.push('体数据原点不一致');
  }
  for (let i = 0; i < 9; i += 1) {
    if (Math.abs(a.direction[i] - b.direction[i]) > 1e-6) errors.push('方向矩阵不一致');
  }
  return errors;
}

function withSide(content: LayerContent | null, side: ReviewSide): LayerContent | null {
  return content ? { ...content, side } : null;
}

export function analyzeReviewMerge(
  volumeA: Volume,
  volumeB: Volume,
  previousChoices: Partial<Record<number, ReviewSide | null>> = {},
): ReviewMergeAnalysis {
  const geometryErrors = sameGeometry(volumeA, volumeB);
  const count = Math.max(volumeA.dimensions[2], volumeB.dimensions[2]);
  const layers: MergeLayer[] = [];

  for (let layer = 0; layer < count; layer += 1) {
    const a = withSide(layerContent(volumeA, layer), 'a');
    const b = withSide(layerContent(volumeB, layer), 'b');
    const t = volumeA.sliceManifest?.[layer]?.t ?? volumeB.sliceManifest?.[layer]?.t ??
      dot(mat3Column(volumeA.direction, 2), positionForLayer(volumeA, layer));
    let status: MergeLayerStatus;
    let required = false;
    let reason = '';
    let selected: ReviewSide | null = null;

    if (geometryErrors.length > 0 && (a || b)) {
      status = 'geometry-conflict';
      required = true;
      reason = '方向、尺寸、位置或栅格存在争议，不能按导入顺序决定';
    } else if (!a && !b) {
      status = 'missing-agreement';
      reason = '两份审阅均保留缺片';
    } else if (a && !b) {
      status = 'unilateral';
      reason = '仅审阅 A 在此位置补入，B 仍缺片';
      selected = previousChoices[layer] === 'b' ? null : 'a';
    } else if (!a && b) {
      status = 'unilateral';
      reason = '仅审阅 B 在此位置补入，A 仍缺片';
      selected = previousChoices[layer] === 'a' ? null : 'b';
    } else if (a!.hash === b!.hash) {
      const sameSource = a!.frame.sourceName === b!.frame.sourceName;
      const sameAcquisition = a!.acquisition === b!.acquisition;
      if (sameSource && sameAcquisition) {
        status = 'agreement';
        reason = '共同来源且内容未改动，双方决定一致，不产生胜者';
      } else if (sameSource) {
        status = 'duplicate';
        reason = '同一来源切片在不同采集批次被重复导入，内容相同只保留一份，不产生胜者';
      } else {
        status = 'agreement';
        reason = '两份审阅独立决定一致，像素内容相同';
      }
      selected = previousChoices[layer] === 'b' ? 'b' : 'a';
    } else {
      status = 'content-conflict';
      required = true;
      selected = previousChoices[layer] === 'a' || previousChoices[layer] === 'b'
        ? (previousChoices[layer] ?? null)
        : null;
      reason = '同一空间位置存在不同像素内容，必须显式选择来源';
    }

    layers.push({ layer, t, status, a, b, selected, required, reason });
  }

  return {
    layers,
    spacing: volumeA.spacing[2],
    unresolvedLayers: layers.filter((item) => item.required && item.selected === null).map((item) => item.layer),
    geometryErrors,
  };
}

export function applyReviewMerge(
  volumeA: Volume,
  volumeB: Volume,
  analysis: ReviewMergeAnalysis,
  label: string,
  window: Volume['window'],
  id: string,
): { volume: Volume; changedFromA: number[]; changedFromB: number[] } {
  const slots = analysis.layers.map((layer) => {
    const content = layer.selected === 'b' ? layer.b : layer.selected === 'a' ? layer.a : null;
    return { t: layer.t, frame: content?.frame ?? null };
  });
  const volume = buildVolumeFromSlots(slots, label, window);
  const manifest: SliceSlot[] = analysis.layers.map((layer) => {
    const content = layer.selected === 'b' ? layer.b : layer.selected === 'a' ? layer.a : null;
    const unresolved = layer.required && layer.selected === null;
    return {
      t: layer.t,
      layer: layer.layer,
      status: content ? 'adopted' : unresolved ? 'uncertain' : 'missing',
      sourceName: content?.sourceName ?? null,
      acquisition: content?.acquisition ?? null,
    };
  });
  const acquisitions = [...new Map(
    [...(volumeA.acquisitions ?? []), ...(volumeB.acquisitions ?? [])].map((item) => [item.id, item]),
  ).values()];
  const merged: Volume = {
    ...volume,
    id,
    sliceManifest: manifest,
    acquisitions,
    mergeSources: { a: volumeA.id, b: volumeB.id },
  };
  return {
    volume: merged,
    changedFromA: analysis.layers.filter((item) => item.selected !== 'a').map((item) => item.layer),
    changedFromB: analysis.layers.filter((item) => item.selected !== 'b').map((item) => item.layer),
  };
}

export function measurementSliceLayers(volume: Volume, m: Pick<Measurement, 'p1' | 'p2'>): number[] {
  const k1 = worldToIjk(m.p1, volume.origin, volume.direction, volume.spacing)[2];
  const k2 = worldToIjk(m.p2, volume.origin, volume.direction, volume.spacing)[2];
  const start = Math.max(0, Math.round(Math.min(k1, k2)));
  const end = Math.min(volume.dimensions[2] - 1, Math.round(Math.max(k1, k2)));
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

export function buildMeasurementBasis(volume: Volume, m: Pick<Measurement, 'p1' | 'p2'>): MeasurementSliceBasis[] {
  return measurementSliceLayers(volume, m).map((layer) => {
    const slot = volume.sliceManifest?.[layer];
    const content = layerContent(volume, layer);
    return {
      layer,
      sourceName: slot?.sourceName ?? null,
      acquisition: slot?.acquisition ?? null,
      hash: content?.hash ?? 'missing',
    };
  });
}

export function mergeMeasurements(
  merged: Volume,
  volumeA: Volume,
  measurementsA: Measurement[],
  volumeB: Volume,
  measurementsB: Measurement[],
): MeasurementMergeResult[] {
  const evaluate = (side: ReviewSide, sourceVolume: Volume, measurements: Measurement[]): MeasurementMergeResult[] =>
    measurements.map((measurement) => {
      const basis = measurement.basisSlices?.length
        ? measurement.basisSlices
        : buildMeasurementBasis(sourceVolume, measurement);
      const missingBasis: number[] = [];
      const changedBasis: number[] = [];
      for (const ref of basis) {
        const current = layerContent(merged, ref.layer);
        if (!current) missingBasis.push(ref.layer);
        else if (current.hash !== ref.hash) changedBasis.push(ref.layer);
      }
      const reusable = missingBasis.length === 0 && changedBasis.length === 0;
      return {
        measurement: {
          ...measurement,
          id: `${side}-${measurement.id}`,
          basisLayers: basis.map((item) => item.layer),
          basisSlices: buildMeasurementBasis(merged, measurement),
          review: reusable ? 'confirmed' : 'pending',
        },
        origin: side,
        reusable,
        missingBasis,
        changedBasis,
      };
    });
  return [...evaluate('a', volumeA, measurementsA), ...evaluate('b', volumeB, measurementsB)];
}
