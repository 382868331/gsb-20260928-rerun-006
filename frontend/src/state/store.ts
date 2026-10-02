import { create } from 'zustand';
import type {
  AcquisitionInfo,
  Measurement,
  ReviewBranch,
  SliceDecision,
  SliceSlot,
  Vec3,
  Volume,
  ImageFrame,
} from '../core/types';
import { analyzeReviewMerge, mergeReviews, withdrawMergeResolution } from '../core/reviewMerge';
import { buildVolumeFromFrames } from '../core/series';
import { analyzeFrameImport, buildVolumeFromAnalysis, type ImportAnalysis } from '../core/importAnalysis';
import {
  analyzePatch,
  applyPatch,
  measurementBasisLayers,
  measurementBasisStillAdopted,
  measurementRangeStatus,
  type PatchAnalysis,
} from '../core/patch';
import { worldToIjk } from '../core/geometry';
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

interface PersistedFrame {
  rows: number;
  cols: number;
  rowSpacing: number;
  colSpacing: number;
  imagePositionPatient: Vec3;
  imageOrientationPatient: [Vec3, Vec3];
  pixels: number[];
  sourceName: string;
  // 该帧内容来自哪一版采集（初始采集或某次补片批次）
  acquisition?: string;
}

interface PersistedImport {
  id?: string; // 数据集 id（补片后保持稳定，重开时恢复）
  label: string;
  window: { center: number; width: number };
  frames: PersistedFrame[];
  // 每层切片的采用清单（含缺片空槽）与采集批次、采用决定
  manifest?: SliceSlot[];
  acquisitions?: AcquisitionInfo[];
  decisions?: SliceDecision[];
  reviewState?: Volume['reviewState'];
}

interface PersistedReviewBranch {
  id: string;
  label: string;
  baseAcquisitionId: string;
  storageImportId: string;
  measurements: Measurement[];
  createdAt: number;
}

interface PersistedDoc {
  version: 1 | 2 | 3;
  sessions: Record<string, DatasetSession>;
  lastDatasetId: string | null;
  // 数据集 id -> 原始帧来源（重开时按原帧重新分析、组卷，保留导入判定）
  imports: Record<string, PersistedImport>;
  reviews?: Record<string, PersistedReviewBranch>;
}

const STORAGE_KEY = 'medical-workstation-v1';

function loadDoc(): PersistedDoc {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const doc = JSON.parse(raw) as PersistedDoc;
      if ((doc.version === 1 || doc.version === 2 || doc.version === 3) && doc.sessions) {
        // 旧版本存档可能没有 imports 字段
        return { ...doc, version: 3, imports: doc.imports ?? {}, reviews: doc.reviews ?? {} };
      }
    }
  } catch {
    // 损坏的持久化文件不应导致应用崩溃
  }
  return { version: 3, sessions: {}, lastDatasetId: null, imports: {}, reviews: {} };
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

interface WorkstationState {
  doc: PersistedDoc;
  volume: Volume | null;
  loadError: string[] | null;
  // 待确认导入：空间排列预览。用户确认前不替换当前数据
  pendingImport: { analysis: ImportAnalysis; label: string; window: Volume['window']; frames: ImageFrame[] } | null;
  // 待确认补片/替换片：逐帧采用决定确认前不改动当前体数据
  pendingPatch: {
    analysis: PatchAnalysis;
    label: string;
    frames: ImageFrame[];
    choices: Record<number, boolean>;
  } | null;
  pendingMerge: {
    branchA: ReviewBranch;
    branchB: ReviewBranch;
    resolutions: Record<number, 'a' | 'b'>;
  } | null;
  reviewBranches: Record<string, ReviewBranch>;
  // 最近一次补片更新前的快照（撤销更新时回到原体数据与测量状态）
  lastUpdate: { volume: Volume; measurements: Measurement[]; doc: PersistedDoc } | null;
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
  // 补片/替换片流程：先分析并预览（新增/重复/冲突逐帧列出），逐帧决定采用
  requestPatch: (frames: ImageFrame[], label: string) => void;
  setPatchChoice: (sourceIndex: number, adopt: boolean) => void;
  confirmPatch: () => void;
  cancelPatch: () => void;
  // 撤销最近一次补片更新，回到更新前的体数据与测量状态
  undoPatch: () => void;
  createReviewBranch: (id: string, label: string) => void;
  openReviewBranch: (id: string) => void;
  requestMergeReviews: (aId: string, bId: string) => void;
  setMergeResolution: (layer: number, side: 'a' | 'b') => void;
  confirmMergeReviews: (label?: string) => void;
  cancelMerge: () => void;
  withdrawMergedLayer: (layer: number) => void;
  // 复核确认：替换片更新后处于待复核的测量由用户重新确认
  confirmMeasurement: (id: string) => void;
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

export const useStore = create<WorkstationState>((set, get) => {
  const initialDoc = loadDoc();
  const reviewStorageId = (id: string) => `review:${id}`;

  const toPersistedFrames = (frames: ImageFrame[], acquisitions?: Array<string | null>): PersistedFrame[] =>
    frames.map((f, i) => ({
      rows: f.rows,
      cols: f.cols,
      rowSpacing: f.rowSpacing,
      colSpacing: f.colSpacing,
      imagePositionPatient: [
        f.imagePositionPatient[0],
        f.imagePositionPatient[1],
        f.imagePositionPatient[2],
      ],
      imageOrientationPatient: [
        [f.imageOrientationPatient[0][0], f.imageOrientationPatient[0][1], f.imageOrientationPatient[0][2]],
        [f.imageOrientationPatient[1][0], f.imageOrientationPatient[1][1], f.imageOrientationPatient[1][2]],
      ],
      pixels: Array.from(f.pixelData),
      sourceName: f.sourceName ?? '',
      acquisition: acquisitions?.[i] ?? undefined,
    }));

  const persistImport = (
    doc: PersistedDoc,
    volume: Volume,
    frames: ImageFrame[],
    label: string,
    window: Volume['window'],
    frameAcquisitions?: Array<string | null>,
  ) => ({
    ...doc,
    imports: {
      ...doc.imports,
      [volume.id]: {
        id: volume.id,
        label,
        window,
        frames: toPersistedFrames(frames, frameAcquisitions),
        manifest: volume.sliceManifest,
        acquisitions: volume.acquisitions,
        decisions: volume.sliceDecisions,
        reviewState: volume.reviewState,
      },
    },
  });

  // 从当前体数据按槽位顺序取出已采用帧（缺片槽位跳过），用于持久化与重开重建
  const framesFromVolume = (volume: Volume): { frames: ImageFrame[]; frameAcquisitions: Array<string | null> } => {
    const [nx, ny, nz] = volume.dimensions;
    const frames: ImageFrame[] = [];
    const frameAcquisitions: Array<string | null> = [];
    for (let k = 0; k < nz; k += 1) {
      const slot = volume.sliceManifest?.[k];
      if (slot && slot.status !== 'adopted') continue;
      frames.push({
        rows: ny,
        cols: nx,
        rowSpacing: volume.spacing[1],
        colSpacing: volume.spacing[0],
        imagePositionPatient: [
          volume.origin[0] + volume.direction[2] * volume.spacing[2] * k,
          volume.origin[1] + volume.direction[5] * volume.spacing[2] * k,
          volume.origin[2] + volume.direction[8] * volume.spacing[2] * k,
        ],
        imageOrientationPatient: [
          [volume.direction[0], volume.direction[3], volume.direction[6]],
          [volume.direction[1], volume.direction[4], volume.direction[7]],
        ],
        pixelData: Float32Array.from(volume.data.subarray(k * nx * ny, (k + 1) * nx * ny)),
        sourceName: slot?.sourceName ?? `${volume.label}/slice-${String(k).padStart(3, '0')}.dcm`,
      });
      frameAcquisitions.push(slot?.acquisition ?? null);
    }
    return { frames, frameAcquisitions };
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
      pendingPatch: null,
      lastUpdate: null,
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
    pendingPatch: null,
    pendingMerge: null,
    reviewBranches: {},
    lastUpdate: null,
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
        set({ loadError: [...analysis.reasons, ...analysis.warnings], pendingImport: null });
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

    requestPatch: (frames, label) => {
      const { volume } = get();
      if (!volume) {
        set({ loadError: ['尚未打开体数据，无法接收补片/替换片'] });
        return;
      }
      if (frames.length === 0) {
        set({ loadError: ['补片批次为空：没有任何影像帧'] });
        return;
      }
      // 只分析不改动：新增位置、重复位置、方向/尺寸冲突逐帧列出，由用户逐帧决定
      const analysis = analyzePatch(volume, frames);
      const choices: Record<number, boolean> = {};
      for (const a of analysis.assessments) choices[a.sourceIndex] = a.defaultAdopt;
      set({ pendingPatch: { analysis, label, frames, choices }, loadError: null });
    },

    setPatchChoice: (sourceIndex, adopt) => {
      const pending = get().pendingPatch;
      if (!pending) return;
      set({
        pendingPatch: {
          ...pending,
          choices: { ...pending.choices, [sourceIndex]: adopt },
        },
      });
    },

    confirmPatch: () => {
      const { pendingPatch, volume, measurements, doc } = get();
      if (!pendingPatch || !volume) return;
      const { analysis, frames, label, choices } = pendingPatch;
      try {
        const result = applyPatch(volume, frames, analysis, choices, label);
        const nextVolume = result.volume;
        // 替换/补片改变了可见内容的层：相关测量进入待复核；未受影响保持原确认
        const changed = new Set(result.changedLayers);
        const nextMeasurements = measurements.map((m) => {
          const touchesChanged = (m.basisLayers ?? []).some((b) => changed.has(b.layer));
          if (touchesChanged || !measurementBasisStillAdopted(nextVolume, m)) {
            return { ...m, review: 'pending' as const };
          }
          return { ...m, basisLayers: measurementBasisLayers(nextVolume, m) };
        });
        const { frames: adoptedFrames, frameAcquisitions } = framesFromVolume(nextVolume);
        let nextDoc = persistImport(
          doc,
          nextVolume,
          adoptedFrames,
          nextVolume.label,
          nextVolume.window,
          frameAcquisitions,
        );
        const clampedSlices: SliceTriple = [
          clampSlice(get().slices[0], nextVolume.dimensions[0]),
          clampSlice(get().slices[1], nextVolume.dimensions[1]),
          clampSlice(get().slices[2], nextVolume.dimensions[2]),
        ];
        const clampedCursor = get().cursorIJK
          ? ([
              clampSlice(get().cursorIJK![0], nextVolume.dimensions[0]),
              clampSlice(get().cursorIJK![1], nextVolume.dimensions[1]),
              clampSlice(get().cursorIJK![2], nextVolume.dimensions[2]),
            ] as [number, number, number])
        : null;
        const session: DatasetSession = {
          slices: clampedSlices,
          cursorIJK: clampedCursor,
          measurements: nextMeasurements,
        };
        nextDoc = {
          ...nextDoc,
          lastDatasetId: nextVolume.id,
          sessions: { ...nextDoc.sessions, [nextVolume.id]: session },
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(nextDoc));
        set({
          doc: nextDoc,
          volume: nextVolume,
          pendingPatch: null,
          loadError: null,
          lastUpdate: { volume, measurements, doc },
          slices: clampedSlices,
          cursorIJK: clampedCursor,
          measurements: nextMeasurements,
        });
      } catch (e) {
        const reasons = Array.isArray((e as { reasons?: unknown }).reasons)
          ? ((e as { reasons: string[] }).reasons)
          : [String(e)];
        set({ loadError: reasons, pendingPatch: null });
      }
    },

    cancelPatch: () => set({ pendingPatch: null }),

    undoPatch: () => {
      const { lastUpdate } = get();
      if (!lastUpdate) return;
      const { volume, measurements, doc } = lastUpdate;
      const session: DatasetSession = {
        slices: [
          clampSlice(get().slices[0], volume.dimensions[0]),
          clampSlice(get().slices[1], volume.dimensions[1]),
          clampSlice(get().slices[2], volume.dimensions[2]),
        ],
        cursorIJK: get().cursorIJK,
        measurements,
      };
      const nextDoc: PersistedDoc = {
        ...doc,
        sessions: { ...doc.sessions, [volume.id]: session },
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(nextDoc));
      set({
        doc: nextDoc,
        volume,
        measurements,
        slices: session.slices,
        lastUpdate: null,
        pendingPatch: null,
        loadError: null,
      });
    },

    createReviewBranch: (id, label) => {
      const { volume, measurements, doc } = get();
      if (!volume) {
        set({ loadError: ['尚未打开采集版本，无法创建独立审阅分支'] });
        return;
      }
      const branch: ReviewBranch = {
        id,
        label,
        baseAcquisitionId: volume.acquisitions?.[0]?.id ?? 'acq-1',
        volume: { ...volume, data: Float32Array.from(volume.data) },
        measurements: measurements.map((m) => ({ ...m, basisLayers: m.basisLayers?.map((b) => ({ ...b })) })),
        createdAt: Date.now(),
      };
      const { frames, frameAcquisitions } = framesFromVolume(branch.volume);
      let nextDoc = persistImport(
        doc,
        { ...branch.volume, id: reviewStorageId(id) },
        frames,
        branch.volume.label,
        branch.volume.window,
        frameAcquisitions,
      );
      const persistedBranch: PersistedReviewBranch = {
        id,
        label,
        baseAcquisitionId: branch.baseAcquisitionId,
        storageImportId: reviewStorageId(id),
        measurements: branch.measurements,
        createdAt: branch.createdAt,
      };
      nextDoc = { ...nextDoc, reviews: { ...(nextDoc.reviews ?? {}), [id]: persistedBranch } };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(nextDoc));
      set({ doc: nextDoc, reviewBranches: { ...get().reviewBranches, [id]: branch } });
    },

    openReviewBranch: (id) => {
      const existing = get().reviewBranches[id];
      if (existing) {
        set({ volume: existing.volume, measurements: existing.measurements });
        return;
      }
      set({ loadError: [`审阅分支 ${id} 不存在`] });
    },

    requestMergeReviews: (aId, bId) => {
      const branchA = get().reviewBranches[aId];
      const branchB = get().reviewBranches[bId];
      if (!branchA || !branchB) {
        set({ loadError: ['两份审阅分支都必须先独立保存，才能合并'] });
        return;
      }
      const analysis = analyzeReviewMerge(branchA.volume, branchB.volume);
      const autoResolutions = Object.fromEntries(
        analysis.items.filter((i) => i.resolution).map((i) => [i.layer, i.resolution!]),
      );
      set({ pendingMerge: { branchA, branchB, resolutions: autoResolutions }, loadError: null });
    },

    setMergeResolution: (layer, side) => {
      const pending = get().pendingMerge;
      if (!pending) return;
      set({
        pendingMerge: {
          ...pending,
          resolutions: { ...pending.resolutions, [layer]: side },
        },
      });
    },

    confirmMergeReviews: (label) => {
      const { pendingMerge, doc } = get();
      if (!pendingMerge) return;
      const result = mergeReviews(pendingMerge.branchA, pendingMerge.branchB, {
        label,
        resolutions: pendingMerge.resolutions,
      });
      if (result.analysis.unresolvedLayers.length > 0) return;
      const { frames, frameAcquisitions } = framesFromVolume(result.volume);
      let nextDoc = persistImport(
        doc,
        result.volume,
        frames,
        result.volume.label,
        result.volume.window,
        frameAcquisitions,
      );
      const session = { slices: [0, 0, 0] as SliceTriple, cursorIJK: null, measurements: result.measurements };
      nextDoc = {
        ...nextDoc,
        lastDatasetId: result.volume.id,
        sessions: { ...nextDoc.sessions, [result.volume.id]: session },
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(nextDoc));
      set({
        doc: nextDoc,
        volume: result.volume,
        measurements: result.measurements,
        slices: session.slices,
        cursorIJK: null,
        pendingMerge: null,
      });
    },

    cancelMerge: () => set({ pendingMerge: null }),

    withdrawMergedLayer: (layer) => {
      const { volume, measurements, doc } = get();
      if (!volume?.reviewState?.mergedFrom) return;
      const restored = withdrawMergeResolution(volume, measurements, layer);
      const { frames, frameAcquisitions } = framesFromVolume(restored.volume);
      const nextDoc = persistImport(
        doc,
        restored.volume,
        frames,
        restored.volume.label,
        restored.volume.window,
        frameAcquisitions,
      );
      localStorage.setItem(STORAGE_KEY, JSON.stringify(nextDoc));
      set({ doc: nextDoc, volume: restored.volume, measurements: restored.measurements });
    },

    confirmMeasurement: (id) => {
      const { volume } = get();
      const next = get().measurements.map((m) => {
        if (m.id !== id) return m;
        if (!volume || measurementRangeStatus(volume, m) !== 'valid') {
          return { ...m, review: 'pending' as const };
        }
        return {
          ...m,
          review: 'confirmed' as const,
          basisLayers: measurementBasisLayers(volume, m),
        };
      });
      set({ measurements: next });
      persistSession({ measurements: next });
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
      const { volume, draftPoint, measurements } = get();
      if (!volume) return;
      if (!draftPoint) {
        set({ draftPoint: world });
        return;
      }
      const dx = world[0] - draftPoint[0];
      const dy = world[1] - draftPoint[1];
      const dz = world[2] - draftPoint[2];
      const measurement: Measurement = {
        id: `m-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        p1: draftPoint,
        p2: world,
        distance: Math.sqrt(dx * dx + dy * dy + dz * dz),
        createdAt: Date.now(),
        // 记录测量所依据的采集版本，后续补片/替换片更新后可追溯
        basisAcquisition:
          volume.acquisitions?.[volume.acquisitions.length - 1]?.id ?? undefined,
        review: 'confirmed',
      };
      measurement.basisLayers = measurementBasisLayers(volume, measurement);
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

function restorePersistedVolume(persisted: PersistedImport): Volume | null {
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
  const analysis = analyzeFrameImport(frames);
  if (!analysis.ok) return null;
  const rebuilt = buildVolumeFromAnalysis(frames, persisted.label, persisted.window, analysis);
  return {
    ...rebuilt,
    id: persisted.id ?? rebuilt.id,
    sliceManifest: persisted.manifest ?? rebuilt.sliceManifest,
    acquisitions: persisted.acquisitions ?? rebuilt.acquisitions,
    sliceDecisions: persisted.decisions ?? rebuilt.sliceDecisions,
    reviewState: persisted.reviewState,
  };
}

export function restoreLastSession() {
  const { doc, openPhantom } = useStore.getState();
  if (!doc.lastDatasetId) return;
  const persisted = doc.imports[doc.lastDatasetId];
  if (persisted) {
    const restored = restorePersistedVolume(persisted);
    if (restored) {
      const session = doc.sessions[restored.id] ?? {
        slices: [0, 0, 0] as SliceTriple,
        cursorIJK: null,
        measurements: [] as Measurement[],
      };
      const reviewBranches: Record<string, ReviewBranch> = {};
      for (const meta of Object.values(doc.reviews ?? {})) {
        const branchVolume = restorePersistedVolume(doc.imports[meta.storageImportId]);
        if (branchVolume) {
          reviewBranches[meta.id] = {
            id: meta.id,
            label: meta.label,
            baseAcquisitionId: meta.baseAcquisitionId,
            volume: branchVolume,
            measurements: meta.measurements,
            createdAt: meta.createdAt,
          };
        }
      }
      const nextDoc: PersistedDoc = { ...doc, lastDatasetId: restored.id };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(nextDoc));
      useStore.setState({
        doc: nextDoc,
        volume: restored,
        pendingImport: null,
        pendingPatch: null,
        slices: session.slices,
        cursorIJK: session.cursorIJK,
        measurements: session.measurements,
        reviewBranches,
      });
      return;
    }
  }
  const def = PHANTOM_CATALOG.find((d) => phantomId(d) === doc.lastDatasetId);
  if (def) openPhantom(def);
}
