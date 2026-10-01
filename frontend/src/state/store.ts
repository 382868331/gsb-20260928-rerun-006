import { create } from 'zustand';
import type { Measurement, Vec3, Volume, ImageFrame } from '../core/types';
import { buildGappedVolumeFromFrames, buildVolumeFromFrames } from '../core/series';
import { analyzeFrameImport, buildVolumeFromAnalysis, type ImportAnalysis } from '../core/importAnalysis';
import { worldToIjk } from '../core/geometry';
import {
  analyzeSupplement,
  applyCandidates,
  pointInValidRange,
  writeManifestData,
  type LayerManifest,
  type LayerSource,
  type SupplementAnalysis,
} from '../core/supplement';
import {
  PHANTOM_CATALOG,
  type PhantomDef,
  buildPhantomFromFrames,
  phantomId,
} from '../core/phantom';

export type SliceTriple = [number, number, number];

interface DatasetSession {
  slices: SliceTriple;
  cursorIJK: [number, number, number] | null;
  measurements: Measurement[];
}

// 一次补丁批次的采用记录：保存选中集合，使重开后可按空间位置无损重放
interface AdoptedBatch {
  batchId: string;
  frames: PersistedFrame[];
  selected: number[];
  adoptedAt: number;
}

interface PersistedFrame {
  rows: number;
  cols: number;
  rowSpacing: number;
  colSpacing: number;
  imagePositionPatient: Vec3;
  imageOrientationPatient: [Vec3, Vec3];
  pixels: number[];
  sourceName: string;
}

interface PersistedImport {
  label: string;
  window: { center: number; width: number };
  frames: PersistedFrame[];
  // 允许缺片的基底（补丁工作流）：frames 有缺，baseTotalLayers 为含空档的总层数
  gapped?: boolean;
  baseTotalLayers?: number;
  // 已采用的补丁批次（按空间位置重放，到达顺序无关）
  batches?: AdoptedBatch[];
}

interface PersistedDoc {
  version: 1;
  sessions: Record<string, DatasetSession>;
  lastDatasetId: string | null;
  // 数据集 id -> 原始帧来源（重开时按原帧重新分析、组卷，保留导入判定）
  imports: Record<string, PersistedImport>;
}

const STORAGE_KEY = 'medical-workstation-v1';

function loadDoc(): PersistedDoc {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const doc = JSON.parse(raw) as PersistedDoc;
      if (doc.version === 1 && doc.sessions) {
        // 旧版本存档可能没有 imports 字段
        return { ...doc, imports: doc.imports ?? {} };
      }
    }
  } catch {
    // 损坏的持久化文件不应导致应用崩溃
  }
  return { version: 1, sessions: {}, lastDatasetId: null, imports: {} };
}

function defaultSlices(volume: Volume): SliceTriple {
  return [
    Math.floor(volume.dimensions[0] / 2),
    Math.floor(volume.dimensions[1] / 2),
    Math.floor(volume.dimensions[2] / 2),
  ];
}

function sessionFor(volume: Volume, doc: PersistedDoc): DatasetSession {
  const saved = doc.sessions[volume.id];
  if (saved) return saved;
  return { slices: defaultSlices(volume), cursorIJK: null, measurements: [] };
}

function serializeFrame(frame: ImageFrame): PersistedFrame {
  return {
    rows: frame.rows,
    cols: frame.cols,
    rowSpacing: frame.rowSpacing,
    colSpacing: frame.colSpacing,
    imagePositionPatient: [
      frame.imagePositionPatient[0],
      frame.imagePositionPatient[1],
      frame.imagePositionPatient[2],
    ],
    imageOrientationPatient: [
      [frame.imageOrientationPatient[0][0], frame.imageOrientationPatient[0][1], frame.imageOrientationPatient[0][2]],
      [frame.imageOrientationPatient[1][0], frame.imageOrientationPatient[1][1], frame.imageOrientationPatient[1][2]],
    ],
    pixels: Array.from(frame.pixelData),
    sourceName: frame.sourceName ?? '',
  };
}

function deserializeFrame(persisted: PersistedFrame): ImageFrame {
  return {
    rows: persisted.rows,
    cols: persisted.cols,
    rowSpacing: persisted.rowSpacing,
    colSpacing: persisted.colSpacing,
    imagePositionPatient: persisted.imagePositionPatient,
    imageOrientationPatient: persisted.imageOrientationPatient,
    pixelData: Float32Array.from(persisted.pixels),
    sourceName: persisted.sourceName,
  };
}

// 由一组基底帧（允许缺片）按沿轴投影构造分层清单，空槽位保留
function manifestFromFrames(
  volume: Volume,
  frames: ImageFrame[],
  adoptedAt: number,
): LayerManifest {
  const ordered = frames
    .map((frame) => ({ frame, t: tOnAxis(volume, frame) }))
    .sort((a, b) => a.t - b.t);
  const layers: Array<LayerSource | null> = new Array(volume.dimensions[2]).fill(null);
  const baseT = ordered[0].t;
  ordered.forEach((item) => {
    const k = Math.round((item.t - baseT) / volume.spacing[2]);
    layers[k] = { frame: item.frame, batchId: 'base', adoptedAt };
  });
  return { layers };
}

function tOnAxis(volume: Volume, frame: ImageFrame): number {
  const colDir: Vec3 = [volume.direction[0], volume.direction[3], volume.direction[6]];
  const rowDir: Vec3 = [volume.direction[1], volume.direction[4], volume.direction[7]];
  const nx = rowDir[1] * colDir[2] - rowDir[2] * colDir[1];
  const ny = rowDir[2] * colDir[0] - rowDir[0] * colDir[2];
  const nz = rowDir[0] * colDir[1] - rowDir[1] * colDir[0];
  return (
    frame.imagePositionPatient[0] * nx +
    frame.imagePositionPatient[1] * ny +
    frame.imagePositionPatient[2] * nz
  );
}

interface WorkstationState {
  doc: PersistedDoc;
  volume: Volume | null;
  loadError: string[] | null;
  // 待确认导入：空间排列预览。用户确认前不替换当前数据
  pendingImport: { analysis: ImportAnalysis; label: string; window: Volume['window']; frames: ImageFrame[] } | null;
  // 当前体数据的分层清单（哪些层采用了哪批采集）；非帧管线体模为 null
  manifest: LayerManifest | null;
  // 已应用到当前体数据的补丁批次（用于撤销与重开追溯）
  adoptedBatches: AdoptedBatch[];
  // 待确认补丁/替换片批次；用户逐张决定采用与否前不改动体数据
  pendingSupplement: {
    analysis: SupplementAnalysis;
    frames: ImageFrame[];
    batchId: string;
    selected: Set<number>;
  } | null;
  slices: SliceTriple;
  cursorIJK: [number, number, number] | null;
  measurements: Measurement[];
  draftPoint: Vec3 | null;
  measureMode: boolean;

  openPhantom: (def: PhantomDef) => void;
  // 直接组卷（保留给程序化路径）；失败时保留当前影像与测量
  openFrames: (frames: ImageFrame[], label: string, window: Volume['window']) => void;
  // 导入流程：先分析并弹出空间排列预览，绝不静默替换
  requestImport: (frames: ImageFrame[], label: string, window: Volume['window']) => void;
  confirmImport: () => void;
  cancelImport: () => void;
  // 打开一个含缺片的帧序列基底（允许缺片，缺层保留为空槽位）
  openGappedFrames: (frames: ImageFrame[], label: string, window: Volume['window']) => void;
  // 请求一批补片/替换片：分析后弹预览，不直接修改体数据
  requestSupplement: (frames: ImageFrame[]) => void;
  toggleCandidate: (sourceIndex: number) => void;
  selectAllCandidates: () => void;
  clearCandidateSelection: () => void;
  confirmSupplement: () => void;
  cancelSupplement: () => void;
  // 撤销最近一次补丁批次，体数据与测量状态回到该批之前
  undoLastBatch: () => void;
  reconfirmMeasurement: (id: string) => void;
  setSlice: (axis: 0 | 1 | 2, slice: number) => void;
  setCursorWorld: (world: Vec3) => void;
  toggleMeasureMode: () => void;
  recordMeasurePoint: (world: Vec3) => void;
  cancelDraft: () => void;
  removeMeasurement: (id: string) => void;
  dismissError: () => void;
}

function clampSlice(value: number, count: number): number {
  return Math.max(0, Math.min(count - 1, Math.round(value)));
}

function ijkFromWorld(volume: Volume, world: Vec3): [number, number, number] {
  const ijk = worldToIjk(world, volume.origin, volume.direction, volume.spacing);
  return [
    clampSlice(ijk[0], volume.dimensions[0]),
    clampSlice(ijk[1], volume.dimensions[1]),
    clampSlice(ijk[2], volume.dimensions[2]),
  ];
}

// 依据更新后的分层清单重新判定每条测量：
// - 患者坐标位置保持不变，只更新“是否仍落在有效影像范围内”
// - changedLayers 中的层可见内容改变 -> 相关测量进入待复核
// - resetReview=true（撤销）时：不在受影响层且范围内的测量回到已确认
function revalidateMeasurements(
  measurements: Measurement[],
  volume: Volume,
  manifest: LayerManifest,
  changedLayers: number[] | null,
  forceReview = true,
  resetReview = false,
): Measurement[] {
  const changedSet = new Set(changedLayers ?? []);
  const layerOf = (world: Vec3) => {
    const ijk = worldToIjk(world, volume.origin, volume.direction, volume.spacing);
    return Math.round(ijk[2]);
  };
  return measurements.map((m) => {
    const inRange =
      pointInValidRange(volume, manifest, m.p1) &&
      pointInValidRange(volume, manifest, m.p2);
    const affected = changedSet.has(layerOf(m.p1)) || changedSet.has(layerOf(m.p2));
    let reviewStatus = m.reviewStatus ?? 'confirmed';
    if (affected && forceReview) reviewStatus = 'review';
    if (resetReview && affected) reviewStatus = inRange ? 'confirmed' : 'review';
    return {
      ...m,
      endpointsInRange: inRange,
      reviewStatus,
      basisVersion: m.basisVersion ?? 'base',
    };
  });
}

export const useStore = create<WorkstationState>((set, get) => {
  const initialDoc = loadDoc();

  const persistImport = (doc: PersistedDoc, volume: Volume, frames: ImageFrame[], label: string, window: Volume['window']) => {
    const persistedFrames: PersistedFrame[] = frames.map(serializeFrame);
    return {
      ...doc,
      imports: {
        ...doc.imports,
        [volume.id]: {
          ...doc.imports[volume.id],
          label,
          window,
          frames: persistedFrames,
        },
      },
    };
  };

  const adoptVolume = (volume: Volume, doc: PersistedDoc) => {
    const session = sessionFor(volume, doc);
    const next: PersistedDoc = {
      ...doc,
      lastDatasetId: volume.id,
      sessions: { ...doc.sessions, [volume.id]: session },
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    set({
      doc: next,
      volume,
      loadError: null,
      pendingImport: null,
      pendingSupplement: null,
      manifest: null,
      adoptedBatches: [],
      slices: session.slices,
      cursorIJK: session.cursorIJK,
      measurements: session.measurements,
      draftPoint: null,
      measureMode: false,
    });
  };

  const persistSession = (patch: Partial<DatasetSession>) => {
    const { volume, doc, slices, cursorIJK, measurements } = get();
    if (!volume) return;
    const session: DatasetSession = { slices, cursorIJK, measurements, ...patch };
    const next: PersistedDoc = {
      ...doc,
      sessions: { ...doc.sessions, [volume.id]: session },
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    set({ doc: next });
  };

  return {
    doc: initialDoc,
    volume: null,
    loadError: null,
    pendingImport: null,
    manifest: null,
    adoptedBatches: [],
    pendingSupplement: null,
    slices: [0, 0, 0],
    cursorIJK: null,
    measurements: [],
    draftPoint: null,
    measureMode: false,

    openPhantom: (def) => {
      adoptVolume(buildPhantomFromFrames(def), get().doc);
    },

    openFrames: (frames, label, wnd) => {
      try {
        adoptVolume(buildVolumeFromFrames(frames, label, wnd), get().doc);
      } catch (e) {
        const reasons = Array.isArray((e as { reasons?: unknown }).reasons)
          ? ((e as { reasons: string[] }).reasons)
          : [String(e)];
        // 组卷失败：不动当前 volume / 测量，仅显示原因
        set({ loadError: reasons });
      }
    },

    requestImport: (frames, label, wnd) => {
      const analysis = analyzeFrameImport(frames);
      // 存在致命冲突时不进入确认流程，只展示逐条原因，当前影像与测量原样保留
      if (!analysis.ok) {
        set({ loadError: analysis.reasons, pendingImport: null });
        return;
      }
      set({ pendingImport: { analysis, label, window: wnd, frames }, loadError: null });
    },

    confirmImport: () => {
      const pending = get().pendingImport;
      if (!pending) return;
      const { analysis, frames, label, window } = pending;
      try {
        const volume = buildVolumeFromAnalysis(frames, label, window, analysis);
        let nextDoc = persistImport(get().doc, volume, frames, label, window);
        const session = sessionFor(volume, nextDoc);
        nextDoc = {
          ...nextDoc,
          lastDatasetId: volume.id,
          sessions: { ...nextDoc.sessions, [volume.id]: session },
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(nextDoc));
        set({
          doc: nextDoc,
          volume,
          pendingImport: null,
          loadError: null,
          slices: session.slices,
          cursorIJK: session.cursorIJK,
          measurements: session.measurements,
          draftPoint: null,
          measureMode: false,
        });
      } catch (e) {
        const reasons = Array.isArray((e as { reasons?: unknown }).reasons)
          ? ((e as { reasons: string[] }).reasons)
          : [String(e)];
        set({ loadError: reasons, pendingImport: null });
      }
    },

    cancelImport: () => set({ pendingImport: null }),

    openGappedFrames: (frames, label, wnd) => {
      try {
        const built = buildGappedVolumeFromFrames(frames, label, wnd);
        const volume = built.volume;
        const manifest = manifestFromFrames(volume, frames, Date.now());
        volume.data.set(writeManifestData(volume, manifest));
        let nextDoc = persistImport(get().doc, volume, frames, label, wnd);
        nextDoc = {
          ...nextDoc,
          imports: {
            ...nextDoc.imports,
            [volume.id]: { ...nextDoc.imports[volume.id], gapped: true, batches: [] },
          },
        };
        const session = sessionFor(volume, nextDoc);
        nextDoc = {
          ...nextDoc,
          lastDatasetId: volume.id,
          sessions: { ...nextDoc.sessions, [volume.id]: session },
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(nextDoc));
        const measurements = revalidateMeasurements(session.measurements, volume, manifest, null);
        const sessionWithStatus = { ...session, measurements };
        nextDoc = {
          ...nextDoc,
          sessions: { ...nextDoc.sessions, [volume.id]: sessionWithStatus },
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(nextDoc));
        set({
          doc: nextDoc,
          volume,
          manifest,
          adoptedBatches: [],
          pendingImport: null,
          pendingSupplement: null,
          loadError: null,
          slices: session.slices,
          cursorIJK: session.cursorIJK,
          measurements,
          draftPoint: null,
          measureMode: false,
        });
      } catch (e) {
        const reasons = Array.isArray((e as { reasons?: unknown }).reasons)
          ? ((e as { reasons: string[] }).reasons)
          : [String(e)];
        set({ loadError: reasons });
      }
    },

    requestSupplement: (frames) => {
      const { volume, manifest } = get();
      if (!volume || !manifest) {
        set({ loadError: ['请先打开支持补片的影像（含缺片基底）'] });
        return;
      }
      if (frames.length === 0) {
        set({ loadError: ['补片批次为空：没有收到任何切片'] });
        return;
      }
      const batchId = 'batch-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e4);
      const analysis = analyzeSupplement(volume, manifest, frames, batchId);
      // 默认勾选可安全采用的补片与替换片；冲突与重复位置不默认采用
      const selected = new Set(
        analysis.candidates
          .filter((c) => c.kind === 'fill' || c.kind === 'replace')
          .map((c) => c.sourceIndex),
      );
      set({ pendingSupplement: { analysis, frames, batchId, selected }, loadError: null });
    },

    toggleCandidate: (sourceIndex) => {
      const pending = get().pendingSupplement;
      if (!pending) return;
      const candidate = pending.analysis.candidates[sourceIndex];
      if (!candidate || candidate.kind === 'conflict') return;
      const selected = new Set(pending.selected);
      if (selected.has(sourceIndex)) selected.delete(sourceIndex);
      else selected.add(sourceIndex);
      set({ pendingSupplement: { ...pending, selected } });
    },

    selectAllCandidates: () => {
      const pending = get().pendingSupplement;
      if (!pending) return;
      const selected = new Set(
        pending.analysis.candidates
          .filter((c) => c.kind !== 'conflict')
          .map((c) => c.sourceIndex),
      );
      set({ pendingSupplement: { ...pending, selected } });
    },

    clearCandidateSelection: () => {
      const pending = get().pendingSupplement;
      if (!pending) return;
      set({ pendingSupplement: { ...pending, selected: new Set() } });
    },

    confirmSupplement: () => {
      const state = get();
      const pending = state.pendingSupplement;
      if (!pending || !state.volume || !state.manifest) return;
      const { volume } = state;
      const previousManifest = state.manifest;
      const previousBatches = state.adoptedBatches;
      const previousMeasurements = state.measurements;
      const adoptedAt = Date.now();
      const applied = applyCandidates(
        previousManifest,
        pending.analysis.candidates,
        pending.selected,
        pending.batchId,
        adoptedAt,
      );
      const changedLayers = applied.changedLayers;
      const nextManifest = applied.manifest;

      // 记录撤销快照所需的上一批状态（撤销时重放到此前批次）
      const record: AdoptedBatch = {
        batchId: pending.batchId,
        frames: pending.frames.map(serializeFrame),
        selected: pending.analysis.candidates
          .filter((c) => pending.selected.has(c.sourceIndex))
          .map((c) => c.sourceIndex),
        adoptedAt,
      };

      // 替换/补全改变了可见内容的层 -> 相关测量进入待复核；其余保持原确认
      const measurements = revalidateMeasurements(
        previousMeasurements,
        volume,
        nextManifest,
        changedLayers,
      );

      const nextData = writeManifestData(volume, nextManifest);
      const nextVolume: Volume = { ...volume, data: nextData };
      const adoptedBatches = [...previousBatches, record];

      let nextDoc: PersistedDoc = {
        ...state.doc,
        imports: {
          ...state.doc.imports,
          [volume.id]: {
            ...state.doc.imports[volume.id],
            batches: adoptedBatches,
          },
        },
      };
      nextDoc = {
        ...nextDoc,
        sessions: { ...nextDoc.sessions, [volume.id]: {
          slices: state.slices,
          cursorIJK: state.cursorIJK,
          measurements,
        } },
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(nextDoc));
      set({
        doc: nextDoc,
        volume: nextVolume,
        manifest: nextManifest,
        adoptedBatches,
        pendingSupplement: null,
        measurements,
        loadError: null,
      });
    },

    cancelSupplement: () => set({ pendingSupplement: null }),

    undoLastBatch: () => {
      const state = get();
      if (!state.volume || !state.manifest || state.adoptedBatches.length === 0) return;
      const volume = state.volume;
      const record = state.adoptedBatches[state.adoptedBatches.length - 1];
      const remainingBatches = state.adoptedBatches.slice(0, -1);

      // 从基底帧重建 manifest，再顺序重放此前批次（按空间位置，顺序无关）
      const persisted = state.doc.imports[volume.id];
      if (!persisted) return;
      const baseFrames = persisted.frames.map(deserializeFrame);
      let manifest = manifestFromFrames(volume, baseFrames, 0);
      for (const batch of remainingBatches) {
        const bFrames = batch.frames.map(deserializeFrame);
        const analysis = analyzeSupplement(volume, manifest, bFrames, batch.batchId);
        const applied = applyCandidates(
          manifest,
          analysis.candidates,
          new Set(batch.selected),
          batch.batchId,
          batch.adoptedAt,
        );
        manifest = applied.manifest;
      }
      // 撤销该批后，其触及层回到上一版（基底或更早批次）内容；
      // 相关测量按更新后的有效性重新判定，此前因本批进入待复核的测量随之回退。
      const undoneAnalysis = analyzeSupplement(
        volume,
        manifest,
        record.frames.map(deserializeFrame),
        record.batchId,
      );
      const undoneLayers = undoneAnalysis.candidates
        .filter((c) => record.selected.includes(c.sourceIndex))
        .map((c) => c.layer);

      const measurements = revalidateMeasurements(
        state.measurements,
        volume,
        manifest,
        undoneLayers,
        /* forceReview */ false,
        /* resetReview */ true,
      );
      const nextVolume: Volume = { ...volume, data: writeManifestData(volume, manifest) };

      let nextDoc: PersistedDoc = {
        ...state.doc,
        imports: {
          ...state.doc.imports,
          [volume.id]: { ...persisted, batches: remainingBatches },
        },
      };
      nextDoc = {
        ...nextDoc,
        sessions: { ...nextDoc.sessions, [volume.id]: {
          slices: state.slices,
          cursorIJK: state.cursorIJK,
          measurements,
        } },
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(nextDoc));
      set({
        doc: nextDoc,
        volume: nextVolume,
        manifest,
        adoptedBatches: remainingBatches,
        measurements,
      });
    },

    reconfirmMeasurement: (id) => {
      const state = get();
      if (!state.volume || !state.manifest) return;
      const measurements = state.measurements.map((m) =>
        m.id === id
          ? {
              ...m,
              reviewStatus: 'confirmed' as const,
              basisVersion: state.adoptedBatches.length > 0
                ? state.adoptedBatches[state.adoptedBatches.length - 1].batchId
                : 'base',
            }
          : m,
      );
      set({ measurements });
      persistSession({ measurements });
    },

    setSlice: (axis, slice) => {
      const { volume, slices } = get();
      if (!volume) return;
      const next = [...slices] as SliceTriple;
      next[axis] = clampSlice(slice, volume.dimensions[axis]);
      set({ slices: next });
      persistSession({ slices: next });
    },

    setCursorWorld: (world) => {
      const { volume } = get();
      if (!volume) return;
      const ijk = ijkFromWorld(volume, world);
      set({ cursorIJK: ijk, slices: ijk });
      persistSession({ cursorIJK: ijk, slices: ijk });
    },

    toggleMeasureMode: () => set((s) => ({ measureMode: !s.measureMode, draftPoint: null })),
    cancelDraft: () => set({ draftPoint: null }),

    recordMeasurePoint: (world) => {
      const { volume, draftPoint, measurements, manifest, adoptedBatches } = get();
      if (!volume) return;
      if (!draftPoint) {
        set({ draftPoint: world });
        return;
      }
      const dx = world[0] - draftPoint[0];
      const dy = world[1] - draftPoint[1];
      const dz = world[2] - draftPoint[2];
      const basisVersion = adoptedBatches.length > 0
        ? adoptedBatches[adoptedBatches.length - 1].batchId
        : 'base';
      const measurement: Measurement = {
        id: `m-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        p1: draftPoint,
        p2: world,
        distance: Math.sqrt(dx * dx + dy * dy + dz * dz),
        createdAt: Date.now(),
        reviewStatus: 'confirmed',
        basisVersion,
        endpointsInRange: manifest
          ? pointInValidRange(volume, manifest, draftPoint) &&
            pointInValidRange(volume, manifest, world)
          : undefined,
      };
      const next = [...measurements, measurement];
      set({ measurements: next, draftPoint: null });
      persistSession({ measurements: next });
    },

    removeMeasurement: (id) => {
      const next = get().measurements.filter((m) => m.id !== id);
      set({ measurements: next });
      persistSession({ measurements: next });
    },

    dismissError: () => set({ loadError: null }),
  };
});

export function restoreLastSession() {
  const { doc, openPhantom } = useStore.getState();
  if (!doc.lastDatasetId) return;
  const persisted = doc.imports[doc.lastDatasetId];
  if (persisted) {
    // 用保存的原始帧重新走分析 + 组卷，几何与 id 稳定，导入判定与来源一并恢复
    const frames: ImageFrame[] = persisted.frames.map((f) => ({
      rows: f.rows,
      cols: f.cols,
      rowSpacing: f.rowSpacing,
      colSpacing: f.colSpacing,
      imagePositionPatient: f.imagePositionPatient,
      imageOrientationPatient: f.imageOrientationPatient,
      pixelData: Float32Array.from(f.pixels),
      sourceName: f.sourceName,
    }));

    if (persisted.gapped) {
      // 缺片基底 + 补丁工作流：重建分层清单，按空间位置顺序重放各批采用决定
      const built = buildGappedVolumeFromFrames(frames, persisted.label, persisted.window);
      const volume = built.volume;
      let manifest = manifestFromFrames(volume, frames, 0);
      const adopted: AdoptedBatch[] = [];
      for (const batch of persisted.batches ?? []) {
        const bFrames = batch.frames.map(deserializeFrame);
        const analysis = analyzeSupplement(volume, manifest, bFrames, batch.batchId);
        const applied = applyCandidates(
          manifest,
          analysis.candidates,
          new Set(batch.selected),
          batch.batchId,
          batch.adoptedAt,
        );
        manifest = applied.manifest;
        adopted.push(batch);
      }
      volume.data.set(writeManifestData(volume, manifest));
      const savedSession = doc.sessions[volume.id] ?? {
        slices: [
          Math.floor(volume.dimensions[0] / 2),
          Math.floor(volume.dimensions[1] / 2),
          Math.floor(volume.dimensions[2] / 2),
        ] as SliceTriple,
        cursorIJK: null,
        measurements: [],
      };
      const measurements = savedSession.measurements.map((m) => ({
        ...m,
        reviewStatus: m.reviewStatus ?? 'confirmed',
        basisVersion: m.basisVersion ?? 'base',
        endpointsInRange:
          pointInValidRange(volume, manifest, m.p1) &&
          pointInValidRange(volume, manifest, m.p2),
      }));
      useStore.setState({
        volume,
        manifest,
        adoptedBatches: adopted,
        slices: savedSession.slices,
        cursorIJK: savedSession.cursorIJK,
        measurements,
        loadError: null,
        pendingImport: null,
        pendingSupplement: null,
      });
      return;
    }

    const analysis = analyzeFrameImport(frames);
    if (analysis.ok) {
      useStore.setState({
        pendingImport: { analysis, label: persisted.label, window: persisted.window, frames },
      });
      useStore.getState().confirmImport();
      return;
    }
  }
  const def = PHANTOM_CATALOG.find((d) => phantomId(d) === doc.lastDatasetId);
  if (def) openPhantom(def);
}
