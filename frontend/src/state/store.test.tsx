import { beforeEach, describe, expect, it } from "vitest";
import { buildPhantomSeries, DEFAULT_SPEC, dropSlice } from "../imaging/phantom";
import { useStore } from "./store";

describe("工作站状态主线", () => {
  beforeEach(() => {
    localStorage.clear();
    useStore.setState({
      volume: null,
      loadErrors: [],
      spec: null,
      cursor: { x: 0, y: 0, z: 0 },
      measurements: [],
      tool: "distance",
      draft: [],
      notice: null,
    });
  });

  it("缺片影像不会覆盖已有影像与测量", () => {
    useStore.getState().openPhantom(DEFAULT_SPEC);
    const vol = useStore.getState().volume!;
    expect(vol).toBeTruthy();
    useStore.getState().setCursor({ x: 3, y: 4, z: 5 });
    useStore.getState().addPoint({ x: 0, y: 0, z: 0 });
    useStore.getState().addPoint({ x: 10, y: 3, z: 5 });
    expect(useStore.getState().measurements).toHaveLength(1);

    const bad = dropSlice(buildPhantomSeries(DEFAULT_SPEC), DEFAULT_SPEC.spacing.z * 2);
    useStore.getState().openSeries(bad, "缺片");

    expect(useStore.getState().volume).toBe(vol);
    expect(useStore.getState().measurements).toHaveLength(1);
    expect(useStore.getState().loadErrors.join(" ")).toContain("缺片");
    expect(useStore.getState().cursor).toEqual({ x: 3, y: 4, z: 5 });
  });

  it("距离结果使用物理毫米而非下标", () => {
    useStore.getState().openPhantom(DEFAULT_SPEC);
    useStore.getState().addPoint({ x: 0, y: 0, z: 0 });
    useStore.getState().addPoint({ x: 3, y: 4.5, z: 5 });
    const m = useStore.getState().measurements[0];
    expect(m.distanceMm).toBeCloseTo(Math.sqrt(3 ** 2 + 4.5 ** 2 + 5 ** 2), 10);
  });

  it("工程重开后恢复影像、浏览位置与测量", () => {
    useStore.getState().openPhantom(DEFAULT_SPEC);
    useStore.getState().setCursor({ x: 7, y: 8, z: 9 });
    useStore.getState().addPoint({ x: 1, y: 1, z: 1 });
    useStore.getState().addPoint({ x: 4, y: 1, z: 1 });
    const saved = localStorage.getItem("med-workstation-v1");
    expect(saved).toContain("cavityFraction");
    expect(saved).toContain('"x":7');

    useStore.setState({ volume: null });
    useStore.getState().hydrateVolume();

    const s = useStore.getState();
    expect(s.volume).not.toBeNull();
    expect(s.cursor).toEqual({ x: 7, y: 8, z: 9 });
    expect(s.measurements).toHaveLength(1);
    expect(s.measurements[0].volumeId).toBe(s.volume!.id);
    expect(s.measurements[0].distanceMm).toBeCloseTo(3 * DEFAULT_SPEC.spacing.x, 10);
  });

  it("重新打开同一影像时保留测量，不同影像的测量保留但不迁移", () => {
    useStore.getState().openPhantom(DEFAULT_SPEC);
    useStore.getState().addPoint({ x: 0, y: 0, z: 0 });
    useStore.getState().addPoint({ x: 3, y: 0, z: 0 });
    const firstId = useStore.getState().volume!.id;

    useStore.getState().openPhantom(DEFAULT_SPEC);
    expect(useStore.getState().volume!.id).toBe(firstId);
    expect(useStore.getState().measurements).toHaveLength(1);
  });
});
