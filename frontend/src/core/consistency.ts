import type { LayerContent, MergeLayer, ReviewSide } from './reviewMerge';

// 层间一致性辅助审阅：根据相邻层几何位置、掩码边界与可用像素标记可疑跳变区间。
// 诊断仅供审阅，绝不凭视觉平滑自动替换任何已确认决定。

export type JumpKind = 'source-difference' | 'missing-slice' | 'spatial-incompatible';

export interface LayerDiagnostics {
  layer: number;
  // 有效像素（非 NaN）比例
  availableFraction: number;
  // 与前一/后一已采用层的物理间距（mm），按患者坐标投影计算而非层号差
  gapBeforeMm: number | null;
  gapAfterMm: number | null;
  // 与前一/后一已采用层前景掩码的 IoU（掩码边界一致性）
  iouBefore: number | null;
  iouAfter: number | null;
  suspicious: boolean;
  kind: JumpKind | null;
  reason: string;
  // 诊断依据：自身与最近邻层内容指纹 + 几何位置；邻域外变化不会使本诊断过期
  basisKey: string;
}

export interface SuspiciousInterval {
  startLayer: number;
  endLayer: number;
  kind: JumpKind;
  layers: number[];
  reason: string;
}

export interface ConsistencyCandidate {
  layer: number;
  from: ReviewSide | null;
  to: ReviewSide;
  // 切换前/后与邻层的掩码连续性（0..1，越大越连续）
  continuityBefore: number;
  continuityAfter: number;
  // 代价：推翻已确认逐层决定数（0/1）与依据该层的测量条数
  costChangedDecisions: number;
  costMeasurements: number;
}

export interface ConsistencyReview {
  diagnostics: LayerDiagnostics[];
  intervals: SuspiciousInterval[];
  candidates: ConsistencyCandidate[];
}

// 掩码边界差异低于该 IoU 视为可疑跳变
const IOU_LIMIT = 0.5;
// 相邻已采用层物理间距超过常规层距的该倍数视为缺层区间
const GAP_FACTOR = 1.5;
// 修改一层时仅该层及其直接邻层的诊断过期
export const DIAGNOSTIC_NEIGHBORHOOD = 1;

function effectiveContent(layer: MergeLayer): LayerContent | null {
  if (layer.selected === 'a') return layer.a;
  if (layer.selected === 'b') return layer.b;
  return null;
}

// 前景掩码：非 NaN 且高于背景（体模背景为 0）的像素
export function foregroundMask(pixels: ArrayLike<number>): Uint8Array {
  const mask = new Uint8Array(pixels.length);
  for (let i = 0; i < pixels.length; i += 1) {
    if (!Number.isNaN(pixels[i]) && pixels[i] > 0) mask[i] = 1;
  }
  return mask;
}

export function maskIou(a: Uint8Array, b: Uint8Array): number {
  let intersection = 0;
  let union = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    if (a[i] && b[i]) intersection += 1;
    if (a[i] || b[i]) union += 1;
  }
  return union === 0 ? 1 : intersection / union;
}

function nearestContentIndex(contents: Array<LayerContent | null>, from: number, step: 1 | -1): number | null {
  for (let k = from + step; k >= 0 && k < contents.length; k += step) {
    if (contents[k]) return k;
  }
  return null;
}

function availableFractionOf(content: LayerContent): number {
  const pixels = content.frame.pixelData;
  let valid = 0;
  for (let i = 0; i < pixels.length; i += 1) {
    if (!Number.isNaN(pixels[i])) valid += 1;
  }
  return pixels.length === 0 ? 0 : valid / pixels.length;
}

export function computeConsistency(layers: MergeLayer[], spacing: number): LayerDiagnostics[] {
  const contents = layers.map(effectiveContent);
  const masks = contents.map((content) => (content ? foregroundMask(content.frame.pixelData) : null));
  const gapLimit = spacing * GAP_FACTOR;

  return layers.map((layer, k) => {
    const content = contents[k];
    const prev = nearestContentIndex(contents, k, -1);
    const next = nearestContentIndex(contents, k, 1);
    const gapBeforeMm = prev !== null ? layer.t - layers[prev].t : null;
    const gapAfterMm = next !== null ? layers[next].t - layer.t : null;
    const iouBefore = prev !== null && content ? maskIou(masks[k]!, masks[prev]!) : null;
    const iouAfter = next !== null && content ? maskIou(masks[k]!, masks[next]!) : null;

    let suspicious = false;
    let kind: JumpKind | null = null;
    let reason = '';
    if (layer.status === 'geometry-conflict') {
      suspicious = true;
      kind = 'spatial-incompatible';
      reason = '方向/尺寸/位置存在争议，空间信息不兼容，不参与层间连续性比较';
    } else if (!content) {
      if (layer.status === 'missing-agreement') {
        suspicious = true;
        kind = 'missing-slice';
        reason = '该层双方均缺片，层间连续性在此中断';
      }
    } else if ((gapBeforeMm !== null && gapBeforeMm > gapLimit) ||
               (gapAfterMm !== null && gapAfterMm > gapLimit)) {
      suspicious = true;
      kind = 'missing-slice';
      reason = `与相邻已采用层物理间距超出常规层距 ${spacing.toFixed(2)}mm 的 ${GAP_FACTOR} 倍，之间存在缺层`;
    } else if ((iouBefore !== null && iouBefore < IOU_LIMIT) ||
               (iouAfter !== null && iouAfter < IOU_LIMIT)) {
      suspicious = true;
      kind = 'source-difference';
      reason = '与相邻已采用层掩码边界差异显著，疑似不同来源内容造成的跳变';
    }

    const basisKey = [
      content?.hash ?? 'none',
      prev !== null ? contents[prev]!.hash : 'none',
      next !== null ? contents[next]!.hash : 'none',
      layer.t.toFixed(3),
    ].join('|');

    return {
      layer: layer.layer,
      availableFraction: content ? availableFractionOf(content) : 0,
      gapBeforeMm,
      gapAfterMm,
      iouBefore,
      iouAfter,
      suspicious,
      kind,
      reason,
      basisKey,
    };
  });
}

// 把连续的可疑层归并为区间（同类相邻合并），供审阅者定位
export function collectIntervals(diagnostics: LayerDiagnostics[]): SuspiciousInterval[] {
  const intervals: SuspiciousInterval[] = [];
  for (const diag of diagnostics) {
    if (!diag.suspicious || !diag.kind) continue;
    const last = intervals[intervals.length - 1];
    if (last && last.kind === diag.kind && last.endLayer === diag.layer - 1) {
      last.endLayer = diag.layer;
      last.layers.push(diag.layer);
    } else {
      intervals.push({
        startLayer: diag.layer,
        endLayer: diag.layer,
        kind: diag.kind,
        layers: [diag.layer],
        reason: diag.reason,
      });
    }
  }
  return intervals;
}

// 修改一层后仅让其直接邻域的诊断过期：邻域内重算，邻域外保留原诊断对象（原依据不变）
export function refreshConsistency(
  previous: LayerDiagnostics[],
  layers: MergeLayer[],
  spacing: number,
  changedLayer: number,
): LayerDiagnostics[] {
  const recomputed = computeConsistency(layers, spacing);
  return recomputed.map((diag, index) =>
    Math.abs(diag.layer - changedLayer) <= DIAGNOSTIC_NEIGHBORHOOD ? diag : (previous[index] ?? diag),
  );
}

function neighborhoodContinuity(masks: Array<Uint8Array | null>, k: number, override: Uint8Array | null): number {
  if (!override) return 0;
  const values: number[] = [];
  for (let j = k - 1; j >= 0; j -= 1) {
    if (masks[j]) {
      values.push(maskIou(override, masks[j]!));
      break;
    }
  }
  for (let j = k + 1; j < masks.length; j += 1) {
    if (masks[j]) {
      values.push(maskIou(override, masks[j]!));
      break;
    }
  }
  if (values.length === 0) return 1;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

// 建立局部候选调整：把某层切换到另一来源，并给出连续性变化与保留原选择的代价。
// 候选本身不改动任何决定，只有审阅者明确批准才进入逐层选择。
export function proposeCandidate(
  layers: MergeLayer[],
  layer: number,
  measurementLayers: number[][],
): ConsistencyCandidate | null {
  const target = layers[layer];
  if (!target || !target.a || !target.b) return null;
  const to: ReviewSide = target.selected === 'a' ? 'b' : 'a';
  const candidateContent = to === 'a' ? target.a : target.b;

  const contents = layers.map(effectiveContent);
  const masks = contents.map((content) => (content ? foregroundMask(content.frame.pixelData) : null));
  const candidateMask = foregroundMask(candidateContent.frame.pixelData);

  const continuityBefore = neighborhoodContinuity(masks, layer, masks[layer]);
  const continuityAfter = neighborhoodContinuity(masks, layer, candidateMask);

  return {
    layer,
    from: target.selected,
    to,
    continuityBefore,
    continuityAfter,
    costChangedDecisions: target.selected !== null && target.selected !== to ? 1 : 0,
    costMeasurements: measurementLayers.filter((set) => set.includes(layer)).length,
  };
}
