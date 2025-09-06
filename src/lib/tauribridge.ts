// src/lib/tauriBridge.ts
export async function bridgeAvailable(): Promise<boolean> {
  // Works with Tauri v1 – presence of __TAURI__ is enough.
  return typeof (window as any).__TAURI__ !== "undefined";
}

export async function tInvoke<T = unknown>(cmd: string, args?: Record<string, any>): Promise<T> {
  if (!(await bridgeAvailable())) {
    throw new Error("Tauri bridge not available");
  }
  const { invoke } = await import("@tauri-apps/api/tauri"); // v1 path
  return invoke<T>(cmd, args);
}
