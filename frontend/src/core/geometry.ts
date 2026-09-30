import type { Mat3, Vec3 } from './types';

export const EPS = 1e-6;

export function vecAdd(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
export function vecSub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
export function vecScale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}
export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
export function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
export function norm(a: Vec3): number {
  return Math.sqrt(dot(a, a));
}
export function normalize(a: Vec3): Vec3 {
  const n = norm(a);
  if (n < EPS) throw new Error('零向量无法归一化');
  return [a[0] / n, a[1] / n, a[2] / n];
}
export function distance(a: Vec3, b: Vec3): number {
  return norm(vecSub(a, b));
}

export function mat3MulVec(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

export function mat3Determinant(m: Mat3): number {
  return (
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[1] * (m[3] * m[8] - m[5] * m[6]) +
    m[2] * (m[3] * m[7] - m[4] * m[6])
  );
}

export function mat3Invert(m: Mat3): Mat3 {
  const det = mat3Determinant(m);
  if (Math.abs(det) < EPS) throw new Error('方向矩阵不可逆');
  const invDet = 1 / det;
  return [
    (m[4] * m[8] - m[5] * m[7]) * invDet,
    (m[2] * m[7] - m[1] * m[8]) * invDet,
    (m[1] * m[5] - m[2] * m[4]) * invDet,
    (m[5] * m[6] - m[3] * m[8]) * invDet,
    (m[0] * m[8] - m[2] * m[6]) * invDet,
    (m[2] * m[3] - m[0] * m[5]) * invDet,
    (m[3] * m[7] - m[4] * m[6]) * invDet,
    (m[1] * m[6] - m[0] * m[7]) * invDet,
    (m[0] * m[4] - m[1] * m[3]) * invDet,
  ];
}

export function mat3Column(m: Mat3, c: 0 | 1 | 2): Vec3 {
  return [m[c * 3], m[c * 3 + 1], m[c * 3 + 2]];
}

export function makeMat3(cols: readonly [Vec3, Vec3, Vec3]): Mat3 {
  return [
    cols[0][0], cols[1][0], cols[2][0],
    cols[0][1], cols[1][1], cols[2][1],
    cols[0][2], cols[1][2], cols[2][2],
  ];
}

// 连续体素索引 -> 患者坐标(体素中心)。结果含不等间距与方向翻转。
export function ijkToWorld(
  ijk: Vec3,
  origin: Vec3,
  direction: Mat3,
  spacing: Vec3,
): Vec3 {
  const scaled: Vec3 = [ijk[0] * spacing[0], ijk[1] * spacing[1], ijk[2] * spacing[2]];
  return vecAdd(origin, mat3MulVec(direction, scaled));
}

export function worldToIjk(
  world: Vec3,
  origin: Vec3,
  direction: Mat3,
  spacing: Vec3,
): Vec3 {
  const inv = mat3Invert(direction);
  const rel = vecSub(world, origin);
  const scaled = mat3MulVec(inv, rel);
  return [scaled[0] / spacing[0], scaled[1] / spacing[1], scaled[2] / spacing[2]];
}

// 患者坐标采用 DICOM LPS：x+ 左、y+ 后、z+ 头侧
const POSITIVE_LABEL = ['L', 'P', 'S'] as const;
const NEGATIVE_LABEL = ['R', 'A', 'I'] as const;
const OPPOSITE: Record<string, string> = { L: 'R', R: 'L', P: 'A', A: 'P', S: 'I', I: 'S' };

// 给定向量指向的解剖方位标签
export function directionLabel(v: Vec3): string {
  let axis = 0;
  let best = Math.abs(v[0]);
  if (Math.abs(v[1]) > best) { axis = 1; best = Math.abs(v[1]); }
  if (Math.abs(v[2]) > best) axis = 2;
  return (v[axis] >= 0 ? POSITIVE_LABEL : NEGATIVE_LABEL)[axis];
}

export function oppositeLabel(label: string): string {
  return OPPOSITE[label] ?? '';
}

export function stableHash(input: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
