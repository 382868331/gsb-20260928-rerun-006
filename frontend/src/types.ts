export type IJK = [number, number, number];

export interface ImageIdentity {
  image_id: string;
  source_image_id?: string;
  name: string;
  shape: [number, number, number];
  voxel_spacing_mm: [number, number, number];
  origin_mm: [number, number, number];
  direction_xyz_from_ijk: number[][];
  affine_ijk_to_xyz: number[][];
  content_domain?: string;
  diagnostic_conclusions?: string[];
}

export interface SlicePayload {
  width: number;
  height: number;
  png_base64: string;
}

export interface Measurement {
  id: string;
  label: string;
  point_a_ijk: IJK;
  point_b_ijk: IJK;
  point_a_xyz_mm: [number, number, number];
  point_b_xyz_mm: [number, number, number];
  distance_mm: number;
}

export interface SessionState {
  crosshair: IJK;
  measurements: Measurement[];
}
