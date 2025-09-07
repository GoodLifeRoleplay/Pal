import React, { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/tauri";

/* =========================================================
   Local storage + types
   ========================================================= */

const CFG_KEY = "palctrl.config.v1";   // { baseUrl, password }
const ST_KEY  = "palctrl.settings.v1"; // { saveDir, intervalMin, startCmd }

// NOTE: `steamId` is optional; `id` is the internal player/session id used by the REST API
type Settings = { saveDir: string; intervalMin: number; startCmd: string; };
type Player = {
  name: string;
  id: string;             // internal player ID (always present)
  steamId?: string;       // prefer this for display/copy if available
  lvl: number;
  ping: number;
  connectedFor?: string;
};

/* =========================================================
   Helpers
   ========================================================= */

function loadJSON<T>(key: string, fallback: T): T {
  try { const raw = localStorage.getItem(key); return raw ? (JSON.parse(raw) as T) : fallback; }
  catch { return fallback; }
}
function saveJSON<T>(key: string, value: T) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

// Accept "45.141.24.11" ⇒ "http://45.141.24.11:8212/v1/api"
function normalizeBaseUrl(input: string): string {
  let s = (input || "").trim();
  if (!s) return s;
  if (!/^https?:\/\//i.test(s)) s = "http://" + s;
  let url: URL;
  try { url = new URL(s); } catch { return (input || "").trim(); }
  if (!url.port) url.port = "8212";
  const p = url.pathname.replace(/\/+$/, "");
  if (!/\/v1\/api$/i.test(p)) url.pathname = p + "/v1/api";
  return url.toString().replace(/\/+$/, "");
}

// Safe Tauri invoke with timeout so UI never hangs
async function call<T>(cmd: string, args?: any, timeoutMs = 15000): Promise<T> {
  const p = invoke<T>(cmd, args);
  const t = new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`Timeout: ${cmd}`)), timeoutMs));
  return Promise.race([p, t]) as Promise<T>;
}

/* =========================================================
   Styles (inline)
   ========================================================= */

const page = { background: "#0b0f14", minHeight: "100vh", color: "#fff", padding: 16 } as const;
const card = {
  background: "#0f141b",
  border: "1px solid rgba(255,255,255,.08)",
  borderRadius: 12,
  padding: 14,
  marginBottom: 14,
} as const;
const row = { display: "flex", gap: 12, flexWrap: "wrap" } as const;
const col = (w: number) => ({ flex: `1 1 ${w}px`, minWidth: w }) as React.CSSProperties;
const head = { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 } as const;
const htitle = { fontWeight: 700, color: "rgba(255,255,255,.92)" } as const;
const label = { fontSize: 12, color: "rgba(255,255,255,.6)", marginBottom: 6 } as const;
const tableWrap = { overflowX: "auto" } as const;
const table = { width: "100%", borderCollapse: "collapse", fontSize: 14 } as const;
const th = { padding: "10px 8px", color: "rgba(255,255,255,.65)", textAlign: "left", borderBottom: "1px solid rgba(255,255,255,.08)" } as const;
const td = { padding: "8px 8px", borderTop: "1px solid rgba(255,255,255,.08)" } as const;
const logBox = {
  height: 260,
  overflow: "auto",
  background: "rgba(0,0,0,.35)",
  border: "1px solid rgba(255,255,255,.12)",
  borderRadius: 10,
  padding: 10,
  fontFamily: "ui-monospace, Menlo, Consolas, 'SF Mono', monospace",
  fontSize: 12,
  lineHeight: 1.6,
} as const;

/* Buttons */
const btnBase = {
  padding: "8px 12px",
  borderRadius: 8,
  border: "1px solid transparent",
  cursor: "pointer",
  fontWeight: 600,
  fontSize: 14,
} as const;
const btnPrimary = { ...btnBase, background: "#0ea5b7", color: "#001317", borderColor: "#0ea5b7" } as const; // teal
const btnSecondary = { ...btnBase, background: "rgba(255,255,255,.08)", color: "#fff", borderColor: "rgba(255,255,255,.18)" } as const;
const btnDanger = { ...btnBase, background: "#ef4444", color: "#fff", borderColor: "#ef4444" } as const;
const btnTiny = { ...btnSecondary, padding: "6px 10px", fontSize: 13 } as const;

/* Inputs */
const input = {
  width: "100%",
  background: "#1a2230",
  border: "1px solid rgba(255,255,255,.14)",
  color: "#fff",
  borderRadius: 8,
  padding: "9px 10px",
} as const;
const textarea = { ...input, minHeight: 120, resize: "vertical" } as const;

/* Modals */
const overlay = { position: "fixed", inset: 0, background: "rgba(0,0,0,.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 } as const;
const modal = { width: "min(720px, 92vw)", background: "#0b1016", border: "1px solid rgba(255,255,255,.12)", borderRadius: 14, padding: 16 } as const;

/* =========================================================
   Broadcast Modal
   ========================================================= */

function BroadcastModal({
  onClose, onSend,
}: { onClose: () => void; onSend: (msg: string) => void | Promise<void>; }) {
  const [msg, setMsg] = useState("");
  return (
    <div style={overlay}>
      <div style={modal}>
        <div style={head}><div style={htitle}>Broadcast Message</div></div>
        <div style={{ marginBottom: 10 }}>
          <div style={label}>Message</div>
          <textarea style={textarea} value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="Type the announcement to send to all players…" />
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button style={btnSecondary} onClick={onClose}>Cancel</button>
          <button
            style={btnPrimary}
            onClick={async () => {
              if (!msg.trim()) return;
              await onSend(msg.trim());
              onClose();
            }}
          >
            Send Broadcast
          </button>
        </div>
      </div>
    </div>
  );
}

/* =========================================================
   Settings Modal (Server URL + Password + Auto-Restart/Backup)
   ========================================================= */

function SettingsModal({
  onClose, onSaved, initial,
}: {
  onClose: () => void;
  onSaved: (cfg: { baseUrl: string; password: string }, st: Settings) => void;
  initial: { cfg: { baseUrl: string; password: string }; st: Settings };
}) {
  const [baseUrl, setBaseUrl] = useState(initial.cfg.baseUrl);
  const [password, setPassword] = useState(initial.cfg.password);
  const [settings, setSettings] = useState<Settings>(initial.st);

  return (
    <div style={overlay}>
      <div style={modal}>
        <div style={head}><div style={htitle}>Settings</div></div>

        {/* Server connection */}
        <div style={{ ...card, marginBottom: 12 }}>
          <div style={htitle}>Server Connection</div>
          <div style={{ marginTop: 8 }}>
            <div style={label}>Server (IP ok; we auto-complete)</div>
            <input style={input} placeholder="e.g. 45.141.24.11" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          </div>
          <div style={{ marginTop: 10 }}>
            <div style={label}>Admin Password</div>
            <input style={input} placeholder="admin password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
        </div>

        {/* Auto-Restart & Backup */}
        <div style={{ ...card, marginBottom: 12 }}>
          <div style={htitle}>Auto-Restart & Backup</div>
          <div style={{ marginTop: 8 }}>
            <div style={label}>Save Directory</div>
            <input style={input} value={settings.saveDir} onChange={(e) => setSettings({ ...settings, saveDir: e.target.value })} />
          </div>
          <div style={{ marginTop: 10, display: "flex", gap: 10 }}>
            <div style={{ flex: "0 0 160px" }}>
              <div style={label}>Interval (minutes)</div>
              <input style={input} type="number" min={5} value={settings.intervalMin} onChange={(e) => setSettings({ ...settings, intervalMin: Math.max(1, Number(e.target.value || 0)) })} />
            </div>
            <div style={{ flex: 1 }}>
              <div style={label}>Start Command (optional)</div>
              <input style={input} placeholder="e.g. C:\\palworldserver\\start-palworld.bat" value={settings.startCmd} onChange={(e) => setSettings({ ...settings, startCmd: e.target.value })} />
            </div>
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button style={btnSecondary} onClick={onClose}>Close</button>
          <button
            style={btnPrimary}
            onClick={async () => {
              const baseUrlNormalized = normalizeBaseUrl(baseUrl);
              saveJSON(CFG_KEY, { baseUrl: baseUrlNormalized, password });
              saveJSON(ST_KEY, settings);
              try {
                await call("set_config", { baseUrl: baseUrlNormalized, password }, 8000);
              } catch (e: any) {
                console.error("set_config failed:", e?.message ?? e);
              }
              onSaved({ baseUrl: baseUrlNormalized, password }, settings);
              onClose();
            }}
          >
            Save Settings
          </button>
        </div>
      </div>
    </div>
  );
}

/* =========================================================
   Main Dashboard
   ========================================================= */

export default function Dashboard() {
  // Persisted config/settings
  const [cfg, setCfg] = useState<{ baseUrl: string; password: string }>(() =>
    loadJSON(CFG_KEY, { baseUrl: "", password: "" })
  );
  const [st, setSt] = useState<Settings>(() =>
    loadJSON(ST_KEY, { saveDir: "C:\\palworldserver\\Pal\\Saved\\SaveGames", intervalMin: 240, startCmd: "" })
  );

  // UI state
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [broadcastOpen, setBroadcastOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [shutdowning, setShutdowning] = useState(false);

  // Server info & players
  const [serverName, setServerName] = useState("—");
  const [uptime, setUptime] = useState("—");
  const [players, setPlayers] = useState<Player[]>([]);

  // Logs
  const [logs, setLogs] = useState<string[]>([]);
  const logRef = useRef<HTMLDivElement | null>(null);
  const pushLog = (line: string) => {
    const stamp = new Date().toLocaleTimeString();
    setLogs((prev) => [...prev, `[${stamp}] ${line}`].slice(-600));
  };
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [logs]);

  // Auto-apply config on launch (normalize first), then fetch info/players
  useEffect(() => {
    (async () => {
      if (cfg.baseUrl) {
        const normalized = normalizeBaseUrl(cfg.baseUrl);
        if (normalized !== cfg.baseUrl) {
          saveJSON(CFG_KEY, { baseUrl: normalized, password: cfg.password });
          setCfg({ baseUrl: normalized, password: cfg.password });
        }
        try {
          await call("set_config", { baseUrl: normalized, password: cfg.password }, 8000);
          pushLog(`Config applied. Base: ${normalized}`);
        } catch (e: any) {
          pushLog(`Auto-apply failed: ${e?.message ?? e}`);
        }
      }
      await refreshInfo();
      await refreshPlayers();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------------- Data fetchers ---------------- */

async function refreshInfo() {
  try {
    // Expecting the same shape as Palworld /info endpoint
    // { "version": "...", "servername": "Papustas world", ... }
    const info = await call<any>("get_server_info", undefined, 8000);

    const name =
      info?.servername ??
      info?.name ??
      info?.server_name ??
      "—";

    setServerName(name);

    // Palworld /info doesn't return uptime; keep whatever we had or show "—"
    if (!uptime || uptime === "—") setUptime("—");

    pushLog("Refreshed server info");
  } catch (e: any) {
    pushLog(`Server info unavailable: ${e?.message ?? e}`);
  }
}


  async function refreshPlayers() {
    try {
      const list = await call<Player[]>("get_players", undefined, 8000);
      setPlayers(Array.isArray(list) ? list : []);
      pushLog(`Players updated (${Array.isArray(list) ? list.length : 0})`);
    } catch (e: any) {
      pushLog(`Players unavailable: ${e?.message ?? e}`);
      setPlayers([]); // keep UI consistent
    }
  }

  /* ---------------- Core actions ---------------- */

  async function doSave() {
    if (saving) return;
    setSaving(true);
    pushLog("Save started…");
    const unlock = setTimeout(() => setSaving(false), 15000);
    try {
      const msg = await call<string>("force_save", undefined, 12000);
      pushLog(`Save dispatched: ${msg}`);
    } catch (e: any) {
      pushLog(`Save failed: ${e?.message ?? e}`);
    } finally {
      clearTimeout(unlock);
      setSaving(false);
    }
  }

  async function doShutdown() {
    if (shutdowning) return;
    setShutdowning(true);
    const unlock = setTimeout(() => setShutdowning(false), 15000);
    try {
      await call("shutdown_server", { seconds: 60, reason: "Manual shutdown" }, 12000);
      pushLog("Shutdown scheduled (60s)");
    } catch (e: any) {
      pushLog(`Shutdown failed: ${e?.message ?? e}`);
    } finally {
      clearTimeout(unlock);
      setShutdowning(false);
    }
  }

  async function doBroadcast(message: string) {
    try {
      await call("announce_text", { message }, 8000);
      pushLog(`Broadcast: ${message}`);
    } catch (e: any) {
      pushLog(`Broadcast failed: ${e?.message ?? e}`);
    }
  }

  /* ---------------- Player actions (Message removed) ---------------- */

  async function kickPlayer(p: Player) {
    try {
      await call("kick_player", { playerId: p.id, reason: "Kicked by admin" }, 8000);
      pushLog(`Kick requested → ${p.name} (${p.id})`);
    } catch (e: any) {
      pushLog(`Kick failed: ${e?.message ?? e}`);
    }
  }

  async function banPlayer(p: Player) {
    try {
      await call("ban_player", { playerId: p.id, reason: "Banned by admin" }, 8000);
      pushLog(`Ban requested → ${p.name} (${p.id})`);
    } catch (e: any) {
      pushLog(`Ban failed: ${e?.message ?? e}`);
    }
  }

  /* ---------------- UI ---------------- */

  return (
    <div style={page}>
      {/* Header (Settings + core actions) */}
      <div style={{ ...card, marginBottom: 18 }}>
        <div style={head}>
          <div style={htitle}>Palworld Control</div>
          <div style={{ display: "flex", gap: 8 }}>
            <button style={btnSecondary} onClick={() => setSettingsOpen(true)}>Settings</button>
          </div>
        </div>
        <div style={row}>
          <div style={{ ...col(240) }}>
            <div style={label}>Name</div>
            <div style={{ fontSize: 16 }}>{serverName}</div>
          </div>
          <div style={{ ...col(240) }}>
            <div style={label}>Players</div>
            <div style={{ fontSize: 16 }}>{players.length || "—"}</div>
          </div>
          <div style={{ ...col(240) }}>
            <div style={label}>Uptime</div>
            <div style={{ fontSize: 16 }}>{uptime}</div>
          </div>
          <div style={{ ...col(420), alignSelf: "flex-end", display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button style={btnPrimary} onClick={doSave} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
            <button style={btnSecondary} onClick={refreshPlayers}>Refresh Players</button>
            <button style={btnPrimary} onClick={() => setBroadcastOpen(true)}>Broadcast Message</button>
            <button style={btnDanger} onClick={doShutdown} disabled={shutdowning}>{shutdowning ? "Scheduling…" : "Shutdown"}</button>
          </div>
        </div>
      </div>

      {/* Players & Actions (combined) */}
      <div style={card}>
        <div style={htitle}>Players & Actions</div>
        <div style={tableWrap}>
          <table style={table}>
            <thead>
              <tr>
                <th style={th}>Name</th>
                <th style={th}>ID (Steam → Player)</th>
                <th style={th}>Lvl</th>
                <th style={th}>Ping</th>
                <th style={th}>Connected</th>
                <th style={{ ...th, width: 320 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {players.length === 0 ? (
                <tr><td colSpan={6} style={td}>No players online</td></tr>
              ) : (
                players.map((p) => {
                  const displayId = (p.steamId && p.steamId.trim()) ? p.steamId : p.id;
                  const title = p.steamId
                    ? `Steam: ${p.steamId}\nPlayer: ${p.id}`
                    : p.id;
                  return (
                    <tr key={p.id}>
                      <td style={td}>{p.name}</td>
                      <td style={td}><span title={title}>{displayId}</span></td>
                      <td style={td}>{p.lvl}</td>
                      <td style={td}>{p.ping}</td>
                      <td style={td}>{p.connectedFor ?? "—"}</td>
                      <td style={td}>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          <button
                            style={btnTiny}
                            onClick={() => {
                              navigator.clipboard?.writeText(displayId).catch(() => {});
                              pushLog(`Copied ID → ${displayId}`);
                            }}
                          >
                            Copy ID
                          </button>
                          <button
                            style={{ ...btnTiny, background: "#0ea5b7", borderColor: "#0ea5b7", color: "#001317" }}
                            onClick={() => kickPlayer(p)}
                          >
                            Kick
                          </button>
                          <button
                            style={{ ...btnTiny, background: "#ef4444", borderColor: "#ef4444" }}
                            onClick={() => banPlayer(p)}
                          >
                            Ban
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Logs */}
      <div style={card}>
        <div style={htitle}>Logs</div>
        <div ref={logRef} style={logBox}>
          {logs.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      </div>

      {/* Modals */}
      {settingsOpen && (
        <SettingsModal
          initial={{ cfg, st }}
          onClose={() => setSettingsOpen(false)}
          onSaved={(newCfg, newSt) => {
            setCfg(newCfg);
            setSt(newSt);
            (async () => {
              try {
                await call("set_config", { baseUrl: newCfg.baseUrl, password: newCfg.password }, 8000);
                await refreshInfo();
                await refreshPlayers();
                pushLog("Settings saved & applied.");
              } catch (e: any) {
                pushLog(`Apply failed: ${e?.message ?? e}`);
              }
            })();
          }}
        />
      )}
      {broadcastOpen && (
        <BroadcastModal
          onClose={() => setBroadcastOpen(false)}
          onSend={(m) => doBroadcast(m)}
        />
      )}
    </div>
  );
}
