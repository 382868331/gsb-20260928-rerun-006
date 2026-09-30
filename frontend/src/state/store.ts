import { create } from 'zustand';
import type { Measurement, Vec3, Volume, ImageFrame } from '../core/types';
import { buildVolumeFromFrames } from '../core/series';
import { analyzeFrameImport, buildVolumeFromAnalysis, type ImportAnalysis } from '../core/importAnalysis';
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
}

interface PersistedImport {
  label: string;
  window: { center: number; width: number };
  frames: PersistedFrame[];
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

interface WorkstationState {
  doc: PersistedDoc;
  volume: Volume | null;
  loadError: string[] | null;
  // 待确认导入：空间排列预览。用户确认前不替换当前数据
  pendingImport: { analysis: ImportAnalysis; label: string; window: Volume['window']; frames: ImageFrame[] } | null;
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

  const persistImport = (doc: PersistedDoc, volume: Volume, frames: ImageFrame[], label: string, window: Volume['window']) => {
    const persistedFrames: PersistedFrame[] = frames.map((f) => ({
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
    }));
    return {
      ...doc,
      imports: {
        ...doc.imports,
        [volume.id]: { label, window, frames: persistedFrames },
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
      return;
    }
  }
  const def = PHANTOM_CATALOG.find((d) => phantomId(d) === doc.lastDatasetId);
  if (def) openPhantom(def);
}
