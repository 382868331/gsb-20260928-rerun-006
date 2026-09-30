import { create } from 'zustand';
import type { Measurement, Vec3, Volume, ImageFrame, ImportInfo } from '../core/types';
import { analyzeFrames, buildVolumeFromFrames, type FrameLayout } from '../core/series';
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

interface PersistedDoc {
  version: number;
  sessions: Record<string, DatasetSession>;
  lastDatasetId: string | null;
  // 最近一次帧序列导入的完整来源与判断，重开后可原样重建（保留导入判断与原始来源）
  lastFrameImport?: SerializedFrameImport | null;
}

const STORAGE_KEY = 'medical-workstation-v1';

// ImageFrame 像素数据为 ArrayLike，localStorage 只能存普通 JSON，需要序列化/还原
export interface SerializedFrame {
  rows: number;
  cols: number;
  rowSpacing: number;
  colSpacing: number;
  imagePositionPatient: Vec3;
  imageOrientationPatient: [Vec3, Vec3];
  pixels: number[];
}

export interface SerializedFrameImport {
  sourceName: string;
  label: string;
  window: Volume['window'];
  frames: SerializedFrame[];
  importedAt: number;
}

export function serializeFrames(frames: ImageFrame[]): SerializedFrame[] {
  return frames.map((f) => ({
    rows: f.rows,
    cols: f.cols,
    rowSpacing: f.rowSpacing,
    colSpacing: f.colSpacing,
    imagePositionPatient: [f.imagePositionPatient[0], f.imagePositionPatient[1], f.imagePositionPatient[2]],
    imageOrientationPatient: [
      [f.imageOrientationPatient[0][0], f.imageOrientationPatient[0][1], f.imageOrientationPatient[0][2]],
      [f.imageOrientationPatient[1][0], f.imageOrientationPatient[1][1], f.imageOrientationPatient[1][2]],
    ],
    pixels: Array.from(f.pixelData),
  }));
}

export function deserializeFrames(serialized: SerializedFrame[]): ImageFrame[] {
  return serialized.map((f) => ({
    rows: f.rows,
    cols: f.cols,
    rowSpacing: f.rowSpacing,
    colSpacing: f.colSpacing,
    imagePositionPatient: f.imagePositionPatient,
    imageOrientationPatient: f.imageOrientationPatient,
    pixelData: new Float32Array(f.pixels),
  }));
}

function loadDoc(): PersistedDoc {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const doc = JSON.parse(raw) as PersistedDoc;
      if ((doc.version === 1 || doc.version === 2) && doc.sessions) {
        return { ...doc, version: 2, lastFrameImport: doc.lastFrameImport ?? null };
      }
    }
  } catch {
    // 损坏的持久化文件不应导致应用崩溃
  }
  return { version: 1, sessions: {}, lastDatasetId: null };
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
  // 导入前空间排列预览：尚未替换当前数据，等待用户确认或取消
  importDraft: {
    frames: ImageFrame[];
    sourceName: string;
    label: string;
    window: Volume['window'];
    layout: FrameLayout;
  } | null;
  slices: SliceTriple;
  cursorIJK: [number, number, number] | null;
  measurements: Measurement[];
  draftPoint: Vec3 | null;
  measureMode: boolean;

  openPhantom: (def: PhantomDef) => void;
  // 第 1 步：只做空间排列分析并弹预览，绝不触碰当前影像与测量
  previewFrames: (frames: ImageFrame[], sourceName: string, label: string, window: Volume['window']) => void;
  // 第 2 步：用户确认后才组卷并替换当前数据；同时记录原始来源与导入判断
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
    importDraft: null,
    slices: [0, 0, 0],
    cursorIJK: null,
    measurements: [],
    draftPoint: null,
    measureMode: false,

    openPhantom: (def) => {
      adoptVolume(buildPhantomFromFrames(def), get().doc);
    },

    previewFrames: (frames, sourceName, label, wnd) => {
      if (frames.length < 2) {
        set({
          loadError: frames.length === 0
            ? ['序列为空：没有任何影像帧']
            : ['切片数量不足：至少需要 2 帧才能确定层间距'],
        });
        return;
      }
      try {
        const layout = analyzeFrames(frames);
        // 无论是否能组成一致体数据，都进入预览：能组卷则可确认，有冲突则只展示具体原因
        set({
          importDraft: { frames, sourceName, label, window: wnd, layout },
          loadError: null,
        });
      } catch (e) {
        const reasons = Array.isArray((e as { reasons?: unknown }).reasons)
          ? ((e as { reasons: string[] }).reasons)
          : [String(e)];
        set({ loadError: reasons });
      }
    },

    confirmImport: () => {
      const draft = get().importDraft;
      if (!draft) return;
      try {
        const importInfo: ImportInfo = {
          sourceName: draft.sourceName,
          importedAt: Date.now(),
          judgment: draft.layout.judgment,
        };
        const built = buildVolumeFromFrames(
          draft.frames,
          draft.label,
          draft.window,
          importInfo,
        );
        // 原始来源（全部帧）与导入判断持久化，重开工程可原样重建
        const doc = get().doc;
        const next: PersistedDoc = {
          ...doc,
          lastFrameImport: {
            sourceName: draft.sourceName,
            label: draft.label,
            window: draft.window,
            frames: serializeFrames(draft.frames),
            importedAt: importInfo.importedAt,
          },
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        adoptVolume(built, next);
        set({ importDraft: null });
      } catch (e) {
        const reasons = Array.isArray((e as { reasons?: unknown }).reasons)
          ? ((e as { reasons: string[] }).reasons)
          : [String(e)];
        set({ importDraft: null, loadError: reasons });
      }
    },

    cancelImport: () => set({ importDraft: null }),

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
  const { doc, openPhantom, previewFrames, confirmImport } = useStore.getState();
  if (!doc.lastDatasetId) return;
  const def = PHANTOM_CATALOG.find((d) => phantomId(d) === doc.lastDatasetId);
  if (def) {
    openPhantom(def);
    return;
  }
  // 帧序列导入的数据：用保存的原始来源原样重建，导入判断随之恢复（id 稳定，测量/浏览位置找回）
  const saved = doc.lastFrameImport;
  if (saved && saved.frames.length > 0) {
    const frames = deserializeFrames(saved.frames);
    previewFrames(frames, saved.sourceName, saved.label, saved.window);
    confirmImport();
  }
}
