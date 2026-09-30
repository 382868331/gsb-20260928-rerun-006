import { create } from 'zustand';
import type { Measurement, Vec3, Volume, ImageFrame } from '../core/types';
import { buildVolumeFromFrames } from '../core/series';
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
  version: 1;
  sessions: Record<string, DatasetSession>;
  lastDatasetId: string | null;
}

const STORAGE_KEY = 'medical-workstation-v1';

function loadDoc(): PersistedDoc {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const doc = JSON.parse(raw) as PersistedDoc;
      if (doc.version === 1 && doc.sessions) return doc;
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
  slices: SliceTriple;
  cursorIJK: [number, number, number] | null;
  measurements: Measurement[];
  draftPoint: Vec3 | null;
  measureMode: boolean;

  openPhantom: (def: PhantomDef) => void;
  openFrames: (frames: ImageFrame[], label: string, window: Volume['window']) => void;
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
        set({ loadError: reasons });
      }
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
  const def = PHANTOM_CATALOG.find((d) => phantomId(d) === doc.lastDatasetId);
  if (def) openPhantom(def);
}
