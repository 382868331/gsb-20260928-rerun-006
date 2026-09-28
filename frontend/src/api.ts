import type { ImageIdentity, IJK, Measurement, SessionState, SlicePayload } from "./types";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const body = await response.json();
      detail = body.detail ?? detail;
    } catch {
      // Keep HTTP status text for non-JSON failures.
    }
    throw new Error(detail);
  }
  return response.json() as Promise<T>;
}

export const api = {
  images: () => request<ImageIdentity[]>("/api/images"),
  importSample: () => request<ImageIdentity>("/api/samples/valid", { method: "POST" }),
  invalidChecks: () =>
    request<Record<string, { accepted: boolean; message: string }>>("/api/samples/invalid/checks"),
  importZip: (file: File) => {
    const form = new FormData();
    form.append("archive", file);
    return request<ImageIdentity>("/api/import/zip", { method: "POST", body: form });
  },
  slice: (id: string, axis: 0 | 1 | 2, index: number) =>
    request<SlicePayload>(`/api/images/${id}/slice/${axis}/${index}`),
  measure: (id: string, pointA: IJK, pointB: IJK) => {
    const payload = {
      label: "空间距离",
      point_a: { ijk: pointA },
      point_b: { ijk: pointB },
    };
    return request<Omit<Measurement, "id" | "label">>(`/api/images/${id}/measurements`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  },
  saveSession: (sessionId: string, imageId: string, state: SessionState) =>
    request(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image_id: imageId, state }),
    }),
  loadSession: (sessionId: string) =>
    request<{ image_id: string; state: SessionState }>(
      `/api/sessions/${encodeURIComponent(sessionId)}`
    ),
};
