// src/lib/tauriBridge.ts
// A safe wrapper that prefers the official Tauri v1 API package,
// and gracefully falls back if we’re running in a plain browser.
export async function tInvoke<T = any>(cmd: string, args?: any): Promise<T> {
  try {
    // Preferred path (Tauri v1): use the official API package
    const { invoke } = await import("@tauri-apps/api/tauri");
    return invoke<T>(cmd, args);
  } catch {
    // Fallbacks (rare): try globals if present (v1 doesn’t normally expose these)
    const g: any = (window as any).__TAURI__;
    const inv = g?.invoke ?? g?.tauri?.invoke ?? null;
    if (!inv) throw new Error("Tauri bridge not available");
    return inv(cmd, args);
  }
}

// quick probe so UI can show a badge if truly unavailable
export async function bridgeAvailable(): Promise<boolean> {
  try {
    const { invoke } = await import("@tauri-apps/api/tauri");
    return typeof invoke === "function";
  } catch {
    const g: any = (window as any).__TAURI__;
    return !!(g?.invoke || g?.tauri?.invoke);
  }
}
