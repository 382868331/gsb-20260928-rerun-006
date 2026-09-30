import { describe, expect, it } from "vitest";
import { buildVolume } from "./geometry";
import { indexToPhysicalCoord, physicalToIndexCoord, distanceMm, expectedSlicePositions } from "./geometry";
import { VIEWS, canvasToPhysical, physicalToCanvas, sampleSlice } from "./mpr";
import { buildPhantomSeries, DEFAULT_SPEC, dropSlice, markerPoints, phantomOrientation, phantomToVolumeIndex } from "./phantom";

function open() {
  const result = buildVolume(buildPhantomSeries(DEFAULT_SPEC), "ignored");
  expect(result.volume).not.toBeNull();
  return result.volume!;
}

describe("方向翻转与不等间距下的坐标解释", () => {
  it("体素下标与物理坐标按 spacing 和 flip 双向换算", () => {
    const vol = open();
    const i = { x: 4, y: 7, z: 9 };
    const p = indexToPhysicalCoord(i, vol);
    expect(p.x).toBeCloseTo(4 * 1.0, 10);
    // y 轴翻转：物理坐标 = -(index - (dims.y-1)) * spacing.y
    expect(p.y).toBeCloseTo(-(7 - (20 - 1)) * 1.5, 10);
    expect(p.z).toBeCloseTo(-(9 - (16 - 1)) * 2.5, 10);
    const back = physicalToIndexCoord(p, vol);
    expect(back.x).toBeCloseTo(4, 10);
    expect(back.y).toBeCloseTo(7, 10);
    expect(back.z).toBeCloseTo(9, 10);
  });

  it("同一体素在三个视图中映射到同一个物理点", () => {
    const vol = open();
    for (const target of [
      { x: 5, y: 6, z: 7 },
      { x: 0, y: 19, z: 15 },
      { x: 23, y: 0, z: 0 },
    ]) {
      const physical = indexToPhysicalCoord(target, vol);
      for (const view of VIEWS) {
        const canvas = physicalToCanvas(vol, view, physical);
        const back = canvasToPhysical(vol, view, canvas.col, canvas.row, canvas.normalIndex);
        expect(back.x).toBeCloseTo(physical.x, 10);
        expect(back.y).toBeCloseTo(physical.y, 10);
        expect(back.z).toBeCloseTo(physical.z, 10);
        const sampled = sampleSlice(vol, view, canvas.normalIndex);
        expect(sampled.values[Math.round(canvas.row) * sampled.width + Math.round(canvas.col)]).toBe(
          vol.data[target.x + vol.dims.x * (target.y + vol.dims.y * target.z)]
        );
      }
    }
  });

  it("物理距离按不等间距计算，而非数组下标", () => {
    const a = indexToPhysicalCoord({ x: 0, y: 0, z: 0 }, open());
    const b = indexToPhysicalCoord({ x: 10, y: 0, z: 0 }, open());
    expect(distanceMm(a, b)).toBeCloseTo(10 * 1.0, 10);
    const c = indexToPhysicalCoord({ x: 0, y: 4, z: 0 }, open());
    expect(distanceMm(a, c)).toBeCloseTo(4 * 1.5, 10);
    const d = indexToPhysicalCoord({ x: 3, y: 2, z: 1 }, open());
    expect(distanceMm(a, d)).toBeCloseTo(
      Math.sqrt((3 * 1.0) ** 2 + (2 * 1.5) ** 2 + (1 * 2.5) ** 2),
      10
    );
  });

  it("空腔中心体素为 0，外壳为高值，标记点为最大值", () => {
    const vol = open();
    const centerIdx = phantomToVolumeIndex(DEFAULT_SPEC, { x: 12, y: 10, z: 8 });
    const center = vol.data[centerIdx.x + 24 * (centerIdx.y + 20 * centerIdx.z)];
    expect(center).toBe(0);
    const shell = vol.data[0];
    expect(shell).toBeGreaterThan(2000);
    for (const m of markerPoints(DEFAULT_SPEC)) {
      const vi = phantomToVolumeIndex(DEFAULT_SPEC, m);
      expect(vol.data[vi.x + 24 * (vi.y + 20 * vi.z)]).toBe(4095);
    }
  });
});

describe("切片完整性与方向校验", () => {
  it("缺少一层时报错且不返回体数据", () => {
    const series = dropSlice(buildPhantomSeries(DEFAULT_SPEC), DEFAULT_SPEC.spacing.z * 3);
    const result = buildVolume(series, "bad");
    expect(result.volume).toBeNull();
    expect(result.errors.join(" ")).toContain("缺片");
    expect(result.errors.join(" ")).toContain((DEFAULT_SPEC.spacing.z * 3).toFixed(2));
  });

  it("列/行/层轴不构成正交轴时判定方向冲突", () => {
    const badOrientation = { ...phantomOrientation(DEFAULT_SPEC), normalAxis: "y" as const, rowAxis: "x" as const };
    const series = { orientation: badOrientation, slices: buildPhantomSeries(DEFAULT_SPEC).slices };
    const result = buildVolume(series, "bad");
    expect(result.volume).toBeNull();
    expect(result.errors[0]).toContain("方向定义冲突");
  });

  it("非法间距被拒绝", () => {
    const bad = {
      orientation: { ...phantomOrientation(DEFAULT_SPEC), spacing: { x: 0, y: 1, z: 1 } },
      slices: buildPhantomSeries(DEFAULT_SPEC).slices,
    };
    expect(buildVolume(bad, "bad").volume).toBeNull();
  });

  it("层位置必须落在 spacing 决定的栅格上", () => {
    const series = buildPhantomSeries(DEFAULT_SPEC);
    series.slices[2].position = 999;
    const result = buildVolume(series, "bad");
    expect(result.volume).toBeNull();
    expect(result.errors.some((e) => e.includes("缺片") || e.includes("超出"))).toBe(true);
  });

  it("期望层位置是物理栅格位置，与层轴翻转无关（翻转只影响下标归位）", () => {
    const positions = expectedSlicePositions(phantomOrientation(DEFAULT_SPEC), 16);
    expect(positions[0]).toBe(0);
    expect(positions[15]).toBeCloseTo(15 * 2.5, 10);
  });
});

describe("体数据身份", () => {
  it("同参数重建得到相同 signature/id，测量不会因重开而失联", () => {
    const v1 = open();
    const v2 = open();
    expect(v1.signature).toBe(v2.signature);
    expect(v1.id).toBe(v2.id);
  });
});
