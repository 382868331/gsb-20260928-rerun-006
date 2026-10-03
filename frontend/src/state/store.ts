import { create } from 'zustand';
import type {
  AcquisitionInfo,
  Measurement,
  SliceDecision,
  SliceSlot,
  Vec3,
  Volume,
  ImageFrame,
} from '../core/types';
import { buildVolumeFromFrames } from '../core/series';
import { analyzeFrameImport, buildVolumeFromAnalysis, type ImportAnalysis } from '../core/importAnalysis';
import {
  analyzePatch,
  applyPatch,
  measurementAffectedByLayers,
  type PatchAnalysis,
} from '../core/patch';
import { worldToIjk } from '../core/geometry';
import {
  PHANTOM_CATALOG,
  type PhantomDef,
  buildPhantomFromFrames,
  phantomId,
} from '../core/phantom';
import {
  analyzeReviewMerge,
  applyReviewMerge,
  buildMeasurementBasis,
  layerContent,
  mergeMeasurements,
  type ReviewMergeAnalysis,
  type ReviewSide,
} from '../core/reviewMerge';

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
  mergeSources?: { a: string; b: string };
}

interface PersistedDoc {
  version: 1 | 2;
  sessions: Record<string, DatasetSession>;
  lastDatasetId: string | null;
  // 数据集 id -> 原始帧来源（重开时按原帧重新分析、组卷，保留导入判定）
  imports: Record<string, PersistedImport>;
  reviewBranches?: Partial<Record<ReviewSide, { id: string; label: string }>>;
  // 合并预览中已作出但未提交的逐层决定：关闭预览/关闭页面后仍需保留
  reviewMergeChoices?: {
    a: string;
    b: string;
    choices: Partial<Record<number, ReviewSide | null>>;
  } | null;
}

const STORAGE_KEY = 'medical-workstation-v1';

function loadDoc(): PersistedDoc {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const doc = JSON.parse(raw) as PersistedDoc;
      if ((doc.version === 1 || doc.version === 2) && doc.sessions) {
        // 旧版本存档可能没有 imports 字段
        return { ...doc, version: 2, imports: doc.imports ?? {} };
      }
    }
  } catch {
    // 损坏的持久化文件不应导致应用崩溃
  }
  return { version: 2, sessions: {}, lastDatasetId: null, imports: {} };
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
  // 两个独立审阅分支的三方合并预览
  pendingReviewMerge: {
    analysis: ReviewMergeAnalysis;
    choices: Partial<Record<number, ReviewSide | null>>;
  } | null;
  reviewBranches: Partial<Record<ReviewSide, { id: string; label: string }>>;
  lastMerge: { volume: Volume; measurements: Measurement[]; doc: PersistedDoc } | null;
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
  saveReviewSide: (side: ReviewSide, label: string) => void;
  openReviewSide: (side: ReviewSide) => void;
  requestReviewMerge: () => void;
  setReviewMergeChoice: (layer: number, side: ReviewSide | null) => void;
  confirmReviewMerge: () => void;
  cancelReviewMerge: () => void;
  undoReviewMerge: () => void;
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
        mergeSources: volume.mergeSources,
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
      pendingReviewMerge: null,
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
    pendingReviewMerge: null,
    lastUpdate: null,
    lastMerge: null,
    reviewBranches: initialDoc.reviewBranches ?? {},
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
        const nextMeasurements = measurements.map((m) => {
          if (m.review === 'pending') return m;
          if (measurementAffectedByLayers(nextVolume, m, result.changedLayers)) {
            return { ...m, review: 'pending' as const };
          }
          return m;
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

    saveReviewSide: (side, label) => {
      const { volume, doc, slices, cursorIJK, measurements } = get();
      if (!volume) return;
      const branchId = `${volume.id}#review-${side}`;
      const branchVolume: Volume = { ...volume, id: branchId, label };
      const { frames, frameAcquisitions } = framesFromVolume(branchVolume);
      let nextDoc = persistImport(doc, branchVolume, frames, label, branchVolume.window, frameAcquisitions);
      // 分支内容被重新保存后，之前针对旧内容作出的合并决定失效，避免按过期选择自动定胜负
      const savedChoices = nextDoc.reviewMergeChoices;
      const invalidateChoices = savedChoices && (savedChoices.a === branchId || savedChoices.b === branchId);
      nextDoc = {
        ...nextDoc,
        lastDatasetId: branchId,
        reviewMergeChoices: invalidateChoices ? null : (savedChoices ?? null),
        reviewBranches: { ...(nextDoc.reviewBranches ?? {}), [side]: { id: branchId, label } },
        sessions: {
          ...nextDoc.sessions,
          [branchId]: { slices, cursorIJK, measurements },
        },
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(nextDoc));
      set({
        doc: nextDoc,
        volume: branchVolume,
        reviewBranches: nextDoc.reviewBranches ?? {},
        pendingPatch: null,
        pendingReviewMerge: null,
        loadError: null,
      });
    },

    openReviewSide: (side) => {
      const branch = get().reviewBranches[side];
      if (!branch) return;
      const nextDoc = { ...get().doc, lastDatasetId: branch.id };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(nextDoc));
      useStore.setState({ doc: nextDoc });
      restoreLastSession();
    },

    requestReviewMerge: () => {
      const { doc, reviewBranches, pendingReviewMerge } = get();
      const branchA = reviewBranches.a;
      const branchB = reviewBranches.b;
      const persistedA = branchA ? doc.imports[branchA.id] : undefined;
      const persistedB = branchB ? doc.imports[branchB.id] : undefined;
      if (!branchA || !branchB || !persistedA || !persistedB) {
        set({ loadError: ['需要先保存 A、B 两份独立审阅，才能开始合并'] });
        return;
      }
      const framesA = persistedA.frames.map((f) => ({
        rows: f.rows,
        cols: f.cols,
        rowSpacing: f.rowSpacing,
        colSpacing: f.colSpacing,
        imagePositionPatient: f.imagePositionPatient,
        imageOrientationPatient: f.imageOrientationPatient,
        pixelData: Float32Array.from(f.pixels),
        sourceName: f.sourceName,
      }));
      const framesB = persistedB.frames.map((f) => ({
        rows: f.rows,
        cols: f.cols,
        rowSpacing: f.rowSpacing,
        colSpacing: f.colSpacing,
        imagePositionPatient: f.imagePositionPatient,
        imageOrientationPatient: f.imageOrientationPatient,
        pixelData: Float32Array.from(f.pixels),
        sourceName: f.sourceName,
      }));
      const analysisA = analyzeFrameImport(framesA);
      const analysisB = analyzeFrameImport(framesB);
      if (!analysisA.ok || !analysisB.ok) {
        set({ loadError: ['来源审阅无法重建：影像帧保存不完整或导入判定失效'] });
        return;
      }
      const rebuiltA = buildVolumeFromAnalysis(framesA, persistedA.label, persistedA.window, analysisA);
      const rebuiltB = buildVolumeFromAnalysis(framesB, persistedB.label, persistedB.window, analysisB);
      const volumeA: Volume = {
        ...rebuiltA,
        id: branchA.id,
        sliceManifest: persistedA.manifest ?? rebuiltA.sliceManifest,
        acquisitions: persistedA.acquisitions ?? rebuiltA.acquisitions,
        sliceDecisions: persistedA.decisions ?? rebuiltA.sliceDecisions,
      };
      const volumeB: Volume = {
        ...rebuiltB,
        id: branchB.id,
        sliceManifest: persistedB.manifest ?? rebuiltB.sliceManifest,
        acquisitions: persistedB.acquisitions ?? rebuiltB.acquisitions,
        sliceDecisions: persistedB.decisions ?? rebuiltB.sliceDecisions,
      };
      // 未提交的决定优先取当前预览；预览已关闭时取上次保存（含关闭页面前）的决定
      const saved = doc.reviewMergeChoices;
      const savedChoices = saved && saved.a === branchA.id && saved.b === branchB.id
        ? saved.choices
        : {};
      const previousChoices = pendingReviewMerge?.choices ?? savedChoices;
      const analysis = analyzeReviewMerge(volumeA, volumeB, previousChoices);
      set({
        pendingReviewMerge: { analysis, choices: { ...previousChoices } },
        loadError: null,
      });
    },

    setReviewMergeChoice: (layer, side) => {
      const pending = get().pendingReviewMerge;
      if (!pending) return;
      const choices = { ...pending.choices, [layer]: side };
      const layers = pending.analysis.layers.map((item) => ({
        ...item,
        selected: item.layer === layer ? side : item.selected,
      }));
      // 每个决定立即持久化：关闭预览或关闭页面后再次打开，决定不回到待定
      const { doc, reviewBranches } = get();
      let nextDoc = doc;
      if (reviewBranches.a && reviewBranches.b) {
        nextDoc = {
          ...doc,
          reviewMergeChoices: {
            a: reviewBranches.a.id,
            b: reviewBranches.b.id,
            choices,
          },
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(nextDoc));
      }
      set({ doc: nextDoc, pendingReviewMerge: { analysis: {
        ...pending.analysis,
        layers,
        unresolvedLayers: layers.filter((item) => item.required && item.selected === null).map((item) => item.layer),
      }, choices } });
    },

    confirmReviewMerge: () => {
      const state = get();
      const pending = state.pendingReviewMerge;
      const branchA = state.reviewBranches.a;
      const branchB = state.reviewBranches.b;
      if (!pending || !branchA || !branchB) return;
      const persistedA = state.doc.imports[branchA.id];
      const persistedB = state.doc.imports[branchB.id];
      if (!persistedA || !persistedB) return;
      state.requestReviewMerge();
      const prepared = get().pendingReviewMerge;
      if (!prepared || prepared.analysis.unresolvedLayers.length > 0) {
        set({
          pendingReviewMerge: pending,
          loadError: [`仍有未处理冲突层：${(prepared?.analysis.unresolvedLayers ?? pending.analysis.unresolvedLayers).map((k) => k + 1).join('、')}`],
        });
        return;
      }
      const framesA = persistedA.frames.map((f) => ({ ...f, pixelData: Float32Array.from(f.pixels) }));
      const framesB = persistedB.frames.map((f) => ({ ...f, pixelData: Float32Array.from(f.pixels) }));
      const baseA = buildVolumeFromAnalysis(framesA, persistedA.label, persistedA.window, analyzeFrameImport(framesA));
      const baseB = buildVolumeFromAnalysis(framesB, persistedB.label, persistedB.window, analyzeFrameImport(framesB));
      const volumeA: Volume = { ...baseA, id: branchA.id, sliceManifest: persistedA.manifest, acquisitions: persistedA.acquisitions, sliceDecisions: persistedA.decisions };
      const volumeB: Volume = { ...baseB, id: branchB.id, sliceManifest: persistedB.manifest, acquisitions: persistedB.acquisitions, sliceDecisions: persistedB.decisions };
      const mergedId = `merge:${branchA.id}|${branchB.id}`;
      const mergeLabel = '合并采集版本';
      const result = applyReviewMerge(volumeA, volumeB, prepared.analysis, mergeLabel, volumeA.window, mergedId);
      const results = mergeMeasurements(
        result.volume,
        volumeA,
        state.doc.sessions[branchA.id]?.measurements ?? [],
        volumeB,
        state.doc.sessions[branchB.id]?.measurements ?? [],
      );
      // 重新合并（撤回某层并另选）时：之前已确认的测量，只有当其全部依据切片
      // 在新合并版中逐层核对仍未变化时才保留确认；任一依据层内容改变即回到待复核。
      const previousMerged = new Map(
        (state.doc.sessions[mergedId]?.measurements ?? []).map((m) => [m.id, m]),
      );
      const mergedMeasurements = results.map((item) => {
        const prev = previousMerged.get(item.measurement.id);
        if (prev?.review === 'confirmed' && prev.basisSlices?.length) {
          const stillValid = prev.basisSlices.every((ref) => {
            const current = layerContent(result.volume, ref.layer);
            return current !== null && current.hash === ref.hash;
          });
          if (stillValid) {
            return { ...item.measurement, review: 'confirmed' as const, basisSlices: prev.basisSlices };
          }
        }
        return item.measurement;
      });
      const { frames, frameAcquisitions } = framesFromVolume(result.volume);
      let nextDoc = persistImport(state.doc, result.volume, frames, mergeLabel, result.volume.window, frameAcquisitions);
      const session: DatasetSession = {
        slices: [0, 0, 0],
        cursorIJK: null,
        measurements: mergedMeasurements,
      };
      nextDoc = {
        ...nextDoc,
        lastDatasetId: result.volume.id,
        // 已提交的逐层决定同样保留：之后可单独撤回某层并另选，而不清空其他层
        reviewMergeChoices: { a: branchA.id, b: branchB.id, choices: prepared.choices },
        sessions: { ...nextDoc.sessions, [result.volume.id]: session },
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(nextDoc));
      set({
        doc: nextDoc,
        volume: result.volume,
        measurements: mergedMeasurements,
        slices: session.slices,
        cursorIJK: null,
        pendingReviewMerge: null,
        pendingPatch: null,
        lastMerge: {
          volume: volumeB,
          measurements: state.doc.sessions[branchB.id]?.measurements ?? [],
          doc: { ...state.doc, lastDatasetId: branchB.id },
        },
        loadError: null,
      });
    },

    cancelReviewMerge: () => set({ pendingReviewMerge: null, loadError: null }),

    undoReviewMerge: () => {
      const { lastMerge } = get();
      if (!lastMerge) return;
      const { volume, measurements, doc } = lastMerge;
      const session: DatasetSession = {
        slices: [
          clampSlice(get().slices[0], volume.dimensions[0]),
          clampSlice(get().slices[1], volume.dimensions[1]),
          clampSlice(get().slices[2], volume.dimensions[2]),
        ],
        cursorIJK: get().cursorIJK,
        measurements,
      };
      const nextDoc = { ...doc, sessions: { ...doc.sessions, [volume.id]: session } };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(nextDoc));
      set({
        doc: nextDoc,
        volume,
        measurements,
        slices: session.slices,
        lastMerge: null,
        pendingReviewMerge: null,
        pendingPatch: null,
        loadError: null,
      });
    },

    confirmMeasurement: (id) => {
      const { volume } = get();
      const next = get().measurements.map((m) => {
        if (m.id !== id) return m;
        const basisSlices = volume ? buildMeasurementBasis(volume, m) : m.basisSlices;
        return {
          ...m,
          review: 'confirmed' as const,
          basisLayers: basisSlices?.map((item) => item.layer) ?? m.basisLayers,
          basisSlices,
          basisAcquisition: volume?.acquisitions?.[volume.acquisitions.length - 1]?.id ?? m.basisAcquisition,
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
        basisAcquisition: volume.acquisitions?.[volume.acquisitions.length - 1]?.id ?? undefined,
        basisLayers: buildMeasurementBasis(volume, { p1: draftPoint, p2: world }).map((item) => item.layer),
        basisSlices: buildMeasurementBasis(volume, { p1: draftPoint, p2: world }),
        review: 'confirmed',
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
    const analysis = analyzeFrameImport(frames);
    if (analysis.ok) {
      useStore.setState({
        pendingImport: { analysis, label: persisted.label, window: persisted.window, frames },
      });
      useStore.getState().confirmImport();
      // 恢复补片/替换片后的状态：稳定 id、每层采用清单、采集批次与采用决定
      if (persisted.manifest || persisted.id) {
        const volume = useStore.getState().volume;
        if (volume) {
          const restored: Volume = {
            ...volume,
            id: persisted.id ?? volume.id,
            sliceManifest: persisted.manifest ?? volume.sliceManifest,
            acquisitions: persisted.acquisitions ?? volume.acquisitions,
            sliceDecisions: persisted.decisions ?? volume.sliceDecisions,
            mergeSources: persisted.mergeSources ?? volume.mergeSources,
          };
          useStore.setState({ volume: restored });
          if (restored.id !== volume.id) {
            // id 被恢复为补片前的稳定 id：把会话与导入记录挂回稳定 id
            const state = useStore.getState();
            // 稳定 id 下已保存的会话（含测量）优先；其次才是刚按重算 id 建的空会话
            const session =
              state.doc.sessions[restored.id] ??
              state.doc.sessions[volume.id] ?? {
                slices: state.slices,
                cursorIJK: state.cursorIJK,
                measurements: state.measurements,
              };
            const nextDoc: PersistedDoc = {
              ...state.doc,
              lastDatasetId: restored.id,
              sessions: { ...state.doc.sessions, [restored.id]: session },
            };
            delete (nextDoc.sessions as Record<string, unknown>)[volume.id];
            localStorage.setItem(STORAGE_KEY, JSON.stringify(nextDoc));
            useStore.setState({
              doc: nextDoc,
              slices: session.slices,
              cursorIJK: session.cursorIJK,
              measurements: session.measurements,
            });
          }
        }
      }
      return;
    }
  }
  const def = PHANTOM_CATALOG.find((d) => phantomId(d) === doc.lastDatasetId);
  if (def) openPhantom(def);
}
