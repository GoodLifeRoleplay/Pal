export type ApiConfig = { base_url: string; token?: string };

let cfg: ApiConfig = { base_url: "" };

export function setConfig(next: ApiConfig) {
  cfg = next;
  const anyWin = window as any;
  const t = anyWin.__TAURI__?.tauri;
  if (!t) throw new Error("Tauri bridge not available");
  return t.invoke("set_api_config", {
    cfg: { baseUrl: cfg.base_url, token: cfg.token ?? null },
  });
}

async function invoke<T = any>(cmd: string, args?: any): Promise<T> {
  // @ts-ignore
  return window.__TAURI__.tauri.invoke(cmd, args);
}

export async function getServerInfo() {
  return invoke("get_server_info");
}
export async function getPlayers() {
  return invoke("get_players");
}
export async function getDurations(): Promise<Record<string, number>> {
  return invoke("player_durations");
}
export async function sendBroadcast(message: string) {
  return invoke("broadcast", { message });
}
export async function forceSave() {
  return invoke("force_save");
}
export async function shutdown(delaySecs: number) {
  return invoke("shutdown", { delaySecs });
}
export async function runBackup(saveDir: string) {
  return invoke<string>("run_backup", { saveDir });
}

export type AutoRestartConfig = {
  interval_minutes: number;
  save_dir: string;
  start_command?: string;
};
export async function startAutoRestart(cfg: AutoRestartConfig) {
  return invoke("start_auto_restart", { cfg });
}
export async function stopAutoRestart() {
  return invoke("stop_auto_restart");
}
