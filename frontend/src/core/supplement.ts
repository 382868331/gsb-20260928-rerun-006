import type { ImageFrame, Vec3, Volume } from './types';
import { cross, dot, worldToIjk } from './geometry';

// 一个已被体数据采用的层来源（含批次标识，用于追溯测量依据的采集版本）
export interface LayerSource {
  frame: ImageFrame;
  // 该层内容所属采集批次：'base' 为原始体数据，其余为补丁批次 id
  batchId: string;
  adoptedAt: number;
}

// 体数据沿切片轴的分层清单：槽位可能为空（缺片）。
// 缺片槽位始终保留：在别的位置到达切片不会让缺片消失。
export interface LayerManifest {
  // 每层 0..nz-1 当前采用的来源；null 表示该空间位置仍缺片
  layers: Array<LayerSource | null>;
}

export type CandidateKind =
  | 'fill' // 补片：落入当前为空（缺片）的栅格槽位
  | 'replace' // 替换片：落入已有内容的槽位，可替换现有切片
  | 'duplicate' // 重复位置：与现有切片像素内容一致，无需替换
  | 'conflict'; // 方向或尺寸与原切片冲突，不能采用

// 一张补充/替换帧相对现有体数据的分析结果
export interface SupplementCandidate {
  sourceIndex: number; // 在本批补片中的提供顺序索引
  sourceName: string;
  frame: ImageFrame;
  kind: CandidateKind;
  layer: number; // 命中的栅格层号；-1 表示无法对齐到栅格
  t: number; // 沿切片轴法线的投影位置 (mm)
  // 冲突/说明信息（方向冲突、尺寸不一致、离栅等）
  issues: string[];
  // 与现有像素是否完全一致（duplicate 判定依据）
  samePixels: boolean;
  orientation: 'parallel' | 'opposite' | 'incompatible';
}

export interface SupplementAnalysis {
  batchId: string;
  candidates: SupplementCandidate[];
  // 现有体数据仍缺片的层号
  missingLayers: number[];
  // 命中后仍将缺片的层号（补的是别的位置时缺片不消失）
  remainingMissingAfterAdopt: number[];
  layerSpacing: number;
  baseT: number;
}

export function sliceAxisGeometry(volume: Volume): { normal: Vec3; spacing: number; baseT: number } {
  // 帧平面法线 = 行方向 x 列方向；翻转层序时与 k 轴相反
  const colDir: Vec3 = [volume.direction[0], volume.direction[3], volume.direction[6]];
  const rowDir: Vec3 = [volume.direction[1], volume.direction[4], volume.direction[7]];
  const normal = cross(rowDir, colDir);
  return {
    normal,
    spacing: volume.spacing[2],
    baseT: dot(volume.origin, normal),
  };
}

function framesEqualPixels(a: ImageFrame, b: ImageFrame): boolean {
  if (a.rows !== b.rows || a.cols !== b.cols || a.pixelData.length !== b.pixelData.length) {
    return false;
  }
  for (let i = 0; i < a.pixelData.length; i += 1) {
    if (a.pixelData[i] !== b.pixelData[i]) return false;
  }
  return true;
}

function frameName(frame: ImageFrame, index: number): string {
  return frame.sourceName ?? ('补片第 ' + (index + 1) + ' 帧');
}

// 分析一批补片/替换帧相对现有体数据与分层清单的关系；纯函数，不修改任何状态。
export function analyzeSupplement(
  volume: Volume,
  manifest: LayerManifest,
  frames: ImageFrame[],
  batchId: string,
): SupplementAnalysis {
  const geom = sliceAxisGeometry(volume);
  const normal = geom.normal;
  const spacing = geom.spacing;
  const baseT = geom.baseT;
  const nz = volume.dimensions[2];

  const candidates: SupplementCandidate[] = frames.map((frame, sourceIndex) => {
    const issues: string[] = [];
    const orient = frame.imageOrientationPatient;
  const colDir = orient[0];
  const rowDir = orient[1];
    const n = cross(rowDir, colDir);
    const normalDot = dot(n, normal);
    let orientation: SupplementCandidate['orientation'] = 'parallel';
    if (Math.abs(normalDot) < 1 - 1e-3) {
      orientation = 'incompatible';
      issues.push('方向与原切片冲突：平面不平行于现有栅格');
    } else if (normalDot < 0) {
      orientation = 'opposite';
      issues.push('方向与原切片冲突：法线反向（来自对侧扫描）');
    }

    if (frame.rows !== volume.dimensions[1] || frame.cols !== volume.dimensions[0]) {
      issues.push(
        '尺寸冲突：' + frame.cols + 'x' + frame.rows +
          '，原切片为 ' + volume.dimensions[0] + 'x' + volume.dimensions[1],
      );
    }
    if (
      Math.abs(frame.rowSpacing - volume.spacing[1]) > 1e-6 ||
      Math.abs(frame.colSpacing - volume.spacing[0]) > 1e-6
    ) {
      issues.push('像素间距与原切片不一致');
    }

    const t = dot(frame.imagePositionPatient, normal);
    const offset = (t - baseT) / spacing;
    const nearest = Math.round(offset);
    let layer = -1;
    if (Math.abs(offset - nearest) <= 1e-3) {
      if (nearest >= 0 && nearest < nz) {
        layer = nearest;
      } else {
        issues.push('位置 t=' + t.toFixed(2) + 'mm 落在现有体数据栅格之外（层 ' + nearest + '）');
      }
    } else {
      issues.push('位置 t=' + t.toFixed(2) + 'mm 不对齐现有栅格（基础层间距 ' + spacing.toFixed(2) + 'mm）');
    }

    const hardConflict = orientation !== 'parallel' || layer < 0 ||
      frame.rows !== volume.dimensions[1] || frame.cols !== volume.dimensions[0] ||
      Math.abs(frame.rowSpacing - volume.spacing[1]) > 1e-6 ||
      Math.abs(frame.colSpacing - volume.spacing[0]) > 1e-6;

    let kind: SupplementCandidate['kind'] = 'conflict';
    let samePixels = false;
    if (!hardConflict && layer >= 0) {
      const existing = manifest.layers[layer];
      if (!existing) {
        kind = 'fill';
      } else {
        samePixels = framesEqualPixels(existing.frame, frame);
        kind = samePixels ? 'duplicate' : 'replace';
      }
    }

    return {
      sourceIndex,
      sourceName: frameName(frame, sourceIndex),
      frame,
      kind,
      layer,
      t,
      issues,
      samePixels,
      orientation,
    };
  });

  const missingLayers = manifest.layers
    .map((src, layer) => (src ? -1 : layer))
    .filter((layer) => layer >= 0);
  const fillLayers = new Set(
    candidates.filter((c) => c.kind === 'fill').map((c) => c.layer),
  );
  const remainingMissingAfterAdopt = missingLayers.filter((layer) => !fillLayers.has(layer));

  return {
    batchId,
    candidates,
    missingLayers,
    remainingMissingAfterAdopt,
    layerSpacing: spacing,
    baseT,
  };
}

// 按层号（空间位置）决定采用候选：到达顺序不同结果一致。
// 返回新分层清单与实际发生内容变化的层号（供测量复核判定）。
export function applyCandidates(
  manifest: LayerManifest,
  candidates: SupplementCandidate[],
  selected: Set<number>,
  batchId: string,
  adoptedAt: number,
): { manifest: LayerManifest; changedLayers: number[] } {
  const layers = manifest.layers.map((src) => (src ? { ...src } : null));
  const changedLayers: number[] = [];
  const byLayer = new Map<number, SupplementCandidate[]>();
  for (const c of candidates) {
    if (!selected.has(c.sourceIndex)) continue;
    if (c.kind !== 'fill' && c.kind !== 'replace') continue;
    const list = byLayer.get(c.layer);
    if (list) list.push(c);
    else byLayer.set(c.layer, [c]);
  }
  for (const [layerStr, list] of byLayer) {
    const layer = Number(layerStr);
    list.sort((a, b) => a.sourceIndex - b.sourceIndex);
    const chosen = list[list.length - 1];
    const previous = layers[layer];
    if (!previous || !framesEqualPixels(previous.frame, chosen.frame)) {
      changedLayers.push(layer);
    }
    layers[layer] = { frame: chosen.frame, batchId, adoptedAt };
  }
  changedLayers.sort((a, b) => a - b);
  return { manifest: { layers }, changedLayers };
}

// 由分层清单重建体数据数据缓冲；空槽位（缺片）写入 NaN 并保留在固定层号。
export function writeManifestData(volume: Volume, manifest: LayerManifest): Float32Array {
  const [nx, ny, nz] = volume.dimensions;
  const data = new Float32Array(nx * ny * nz);
  for (let k = 0; k < nz; k += 1) {
    const src = manifest.layers[k];
    if (src) data.set(src.frame.pixelData, k * nx * ny);
    else data.fill(NaN, k * nx * ny, (k + 1) * nx * ny);
  }
  return data;
}

// 判断世界坐标点是否落在体数据有效影像范围内（包围盒内，且所在层不是缺片）。
export function pointInValidRange(
  volume: Volume,
  manifest: LayerManifest,
  world: Vec3,
): boolean {
  const dims = volume.dimensions;
  const ijk = worldToIjk(world, volume.origin, volume.direction, volume.spacing);
  if (ijk[0] < -0.5 || ijk[0] > dims[0] - 0.5) return false;
  if (ijk[1] < -0.5 || ijk[1] > dims[1] - 0.5) return false;
  if (ijk[2] < -0.5 || ijk[2] > dims[2] - 0.5) return false;
  const k = Math.round(ijk[2]);
  return manifest.layers[k] !== null;
}
