import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Measurement, Point3, SliceSeries, Volume } from "../types";
import { buildVolume } from "../imaging/geometry";
import { buildPhantomSeries, DEFAULT_SPEC, type PhantomSpec } from "../imaging/phantom";
import { distanceMm } from "../imaging/geometry";

export type ToolMode = "browse" | "point" | "distance";

interface Cursor {
  x: number;
  y: number;
  z: number;
}

interface WorkstationState {
  volume: Volume | null;
  loadErrors: string[];
  spec: PhantomSpec | null;
  cursor: Cursor;
  measurements: Measurement[];
  tool: ToolMode;
  draft: Point3[];
  notice: string | null;

  openPhantom: (spec: PhantomSpec) => void;
  /** 打开任一切片序列；失败时保留原影像和测量。 */
  openSeries: (series: SliceSeries, description: string) => void;
  setCursor: (c: Partial<Cursor>) => void;
  setTool: (t: ToolMode) => void;
  addPoint: (p: Point3) => void;
  cancelDraft: () => void;
  removeMeasurement: (id: string) => void;
  clearNotice: () => void;
  hydrateVolume: () => void;
}

let idCounter = 0;
function uid(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`;
}

function openWithSeries(
  series: SliceSeries,
  description: string,
  prev: Pick<WorkstationState, "volume" | "measurements" | "cursor">
): Partial<WorkstationState> {
  const result = buildVolume(series, uid("vol"), description);
  if (!result.volume) {
    return {
      loadErrors: result.errors,
      notice: `影像无法组成完整体数据，已保留当前影像与测量：${result.errors[0]}`,
    };
  }
  const vol = result.volume;
  const sameVolume = prev.volume?.signature === vol.signature;
  return {
    volume: vol,
    loadErrors: [],
    draft: [],
    notice: sameVolume
      ? "打开的影像与当前影像一致，测量与浏览位置保留"
      : prev.volume
        ? "新影像几何/内容与当前影像不同，原影像的测量不会迁移到新影像"
        : null,
    cursor: sameVolume
      ? prev.cursor
      : {
          x: Math.floor(vol.dims.x / 2),
          y: Math.floor(vol.dims.y / 2),
          z: Math.floor(vol.dims.z / 2),
        },
  };
}

export const useStore = create<WorkstationState>()(
  persist(
    (set, get) => ({
      volume: null,
      loadErrors: [],
      spec: null,
      cursor: { x: 0, y: 0, z: 0 },
      measurements: [],
      tool: "distance",
      draft: [],
      notice: null,

      openPhantom: (spec) => {
        const patch = openWithSeries(buildPhantomSeries(spec), phantomDescription(spec), get());
        if (patch.volume) set({ ...patch, spec });
        else set(patch);
      },

      openSeries: (series, description) => {
        const patch = openWithSeries(series, description, get());
        if (patch.volume) set({ ...patch, spec: null });
        else set(patch);
      },

      setCursor: (c) => {
        const vol = get().volume;
        if (!vol) return;
        set({
          cursor: {
            x: clamp(c.x ?? get().cursor.x, vol.dims.x),
            y: clamp(c.y ?? get().cursor.y, vol.dims.y),
            z: clamp(c.z ?? get().cursor.z, vol.dims.z),
          },
        });
      },

      setTool: (tool) => set({ tool, draft: [] }),

      addPoint: (p) => {
        const { tool, draft, volume, measurements } = get();
        if (!volume || tool === "browse") return;
        const next = [...draft, p];
        if (tool === "point" || next.length === 2) {
          const m: Measurement = {
            id: uid("m"),
            volumeId: volume.id,
            type: tool,
            points: next,
            distanceMm: next.length === 2 ? distanceMm(next[0], next[1]) : null,
            label:
              tool === "point"
                ? `点 P${measurements.filter((x) => x.type === "point").length + 1}`
                : `距离 D${measurements.filter((x) => x.type === "distance").length + 1}`,
            createdAt: Date.now(),
          };
          set({ measurements: [...measurements, m], draft: [] });
        } else {
          set({ draft: next });
        }
      },

      cancelDraft: () => set({ draft: [] }),
      removeMeasurement: (id) =>
        set({ measurements: get().measurements.filter((m) => m.id !== id), draft: [] }),
      clearNotice: () => set({ notice: null }),

      hydrateVolume: () => {
        const { spec, volume } = get();
        if (!volume && spec) {
          const result = buildVolume(buildPhantomSeries(spec), uid("vol"), phantomDescription(spec));
          if (result.volume) set({ volume: result.volume, loadErrors: [] });
        }
      },
    }),
    {
      name: "med-workstation-v1",
      partialize: (s) => ({
        spec: s.spec,
        cursor: s.cursor,
        measurements: s.measurements,
        tool: s.tool,
      }),
    }
  )
);

function clamp(v: number, dim: number): number {
  return Math.max(0, Math.min(dim - 1, Math.round(v)));
}

export function phantomDescription(spec: PhantomSpec): string {
  return `人工体模 ${spec.dims.x}×${spec.dims.y}×${spec.dims.z}，间距 ${spec.spacing.x}/${spec.spacing.y}/${spec.spacing.z} mm，翻转轴 ${(
    ["x", "y", "z"] as const
  )
    .filter((ax) => spec.flip[ax])
    .join("、") || "无"}`;
}

export { DEFAULT_SPEC };
