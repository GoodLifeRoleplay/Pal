import React, { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/api/dialog";
import { invoke } from "@tauri-apps/api/tauri";
import { normalizeBaseUrl } from "../lib/url";

type ApiConfig = {
  base_url: string;
  password?: string | null;
  restart_times?: string[];
  start_cmd?: string | null;
  backup_dir?: string | null;
  backup_dest_dir?: string | null;
};

type Player = {
  id: string;
  name: string;
  level?: number;
  ping?: number;
  connected_seconds?: number;
};

function ts() {
  const d = new Date();
  return d.toLocaleTimeString([], { hour12: true, hour: "numeric", minute: "2-digit", second: "2-digit" });
}

function fmtUptime(sec?: number | null) {
  if (!sec || sec <= 0) return "?";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${m}m`;
}

function fmtConnectedSeconds(s?: number | null) {
  if (s == null || s < 0) return "?";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export default function Dashboard() {
  // config + UI state
  const [cfg, setCfg] = useState<ApiConfig>({ base_url: "", password: "" });
  const [serverName, setServerName] = useState<string>("?");
  const [playersCount, setPlayersCount] = useState<number>(0);
  const [uptime, setUptime] = useState<number | null>(null);
  const [players, setPlayers] = useState<Player[]>([]);
  const [saving, setSaving] = useState(false);
  const [broadcastMsg, setBroadcastMsg] = useState("");
  const [broadcastOpen, setBroadcastOpen] = useState(false);
  const [timeModal, setTimeModal] = useState<null | { kind: "restart" | "shutdown"; seconds: number }>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [restartTimesText, setRestartTimesText] = useState("");
  const [logs, setLogs] = useState<string[]>([]);
  const [startCmd, setStartCmd] = useState<string>("");
  const [backupDir, setBackupDir] = useState<string>("");
  const [backupDestDir, setBackupDestDir] = useState<string>("");
  const [discordHook, setDiscordHook] = useState<string>("");
  const [allowActions, setAllowActions] = useState<boolean>(true);
  const loadedRef = React.useRef(false);
  const lastAppliedRef = React.useRef<string>("");
  const [connStatus, setConnStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [liveConn, setLiveConn] = useState<{ ok: boolean; msg?: string } | null>(null);
  const [restartCountdown, setRestartCountdown] = useState<number | null>(null);
  const restartTimerRef = React.useRef<number | null>(null);
  const [backupsOpen, setBackupsOpen] = useState(false);
  const prevPlayersRef = React.useRef<Map<string, string>>(new Map());
  const [refreshHoldUntil, setRefreshHoldUntil] = useState<number>(0); // epoch ms to skip refreshes

  // Newest first: prepend to the list so latest logs appear at the top
  const pushLog = (line: string) =>
    setLogs((prev) => [`[${ts()}] ${line}`, ...prev].slice(0, 500));

  // load config from backend on mount
  useEffect(() => {
    (async () => {
      try {
        const c = (await invoke("get_config")) as ApiConfig;
        const base_url = (c?.base_url || "").trim();
        const password = c?.password ?? "";
        setCfg({ base_url, password, restart_times: c.restart_times ?? [], start_cmd: c.start_cmd ?? null, backup_dir: c.backup_dir ?? null, backup_dest_dir: (c as any).backup_dest_dir ?? null });
        setRestartTimesText((c.restart_times ?? []).join(", "));
        setStartCmd(c.start_cmd || "");
        setBackupDir(c.backup_dir || "");
        setBackupDestDir((c as any).backup_dest_dir || "");
        setDiscordHook((c as any).discord_webhook || (c as any).discordWebhook || "");
        setAllowActions((c as any).allow_actions ?? true);
        pushLog(`Loaded settings. Base: ${base_url || "(not set)"}`);
        if (base_url) {
          // One-time auto-apply on start using the fully loaded values to avoid overwriting
          const payload: any = {
            base_url,
            baseUrl: base_url,
            password: password || null,
            restart_times: c.restart_times ?? [],
            restartTimes: c.restart_times ?? [],
            start_cmd: c.start_cmd || null,
            startCmd: c.start_cmd || null,
            backup_dir: c.backup_dir || null,
            backupDir: c.backup_dir || null,
            backup_dest_dir: (c as any).backup_dest_dir || null,
            backupDestDir: (c as any).backup_dest_dir || null,
            discord_webhook: (c as any).discord_webhook || null,
            discordWebhook: (c as any).discord_webhook || null,
            allow_actions: (c as any).allow_actions ?? true,
            allowActions: (c as any).allow_actions ?? true,
          };
          try {
            await invoke("set_config", payload);
            lastAppliedRef.current = `${normalizeBaseUrl(base_url)}|${password}|${(c.restart_times??[]).join(",")}|${c.start_cmd||""}|${c.backup_dir||""}|${(c as any).backup_dest_dir||""}|${(c as any).discord_webhook||""}`;
            pushLog("Settings applied from disk");
          } catch (e: any) {
            pushLog(`Auto-apply from disk failed: ${e?.toString?.() || e}`);
          }
          await refreshAll();
        }
        loadedRef.current = true;
      } catch (e: any) {
        pushLog(`Failed to load settings: ${e?.toString?.() || e}`);
      }
    })();
  }, []);

  // periodic refresh (every 30s), respects refresh hold window
  useEffect(() => {
    if (!cfg.base_url) return;
    const id = setInterval(() => {
      const now = Date.now();
      if (now < refreshHoldUntil) {
        // skip until hold expires
        return;
      }
      refreshAll();
    }, 30_000);
    return () => clearInterval(id);
  }, [cfg.base_url, refreshHoldUntil]);

  // local uptime ticker for smoother display
  useEffect(() => {
    const t = setInterval(() => {
      setUptime((u) => (u == null ? u : u + 1));
    }, 1000);
    return () => clearInterval(t);
  }, []);

  // restart countdown timer
  useEffect(() => {
    if (restartCountdown == null) return;
    if (restartTimerRef.current != null) window.clearInterval(restartTimerRef.current);
    restartTimerRef.current = window.setInterval(() => {
      setRestartCountdown((s) => {
        if (s == null) return s;
        if (s <= 1) {
          if (restartTimerRef.current != null) window.clearInterval(restartTimerRef.current);
          return null;
        }
        return s - 1;
      });
    }, 1000);
    return () => {
      if (restartTimerRef.current != null) window.clearInterval(restartTimerRef.current);
      restartTimerRef.current = null;
    };
  }, [restartCountdown]);

  function parseRestartTimes(input: string): string[] {
    const items = input
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const m = s.match(/^(\d{1,2}):(\d{2})$/);
        if (!m) return null as any;
        let hh = Math.max(0, Math.min(23, parseInt(m[1], 10))).toString().padStart(2, "0");
        let mm = Math.max(0, Math.min(59, parseInt(m[2], 10))).toString().padStart(2, "0");
        return `${hh}:${mm}`;
      })
      .filter(Boolean) as string[];
    return Array.from(new Set(items)).sort();
  }

  async function applySettings(next: ApiConfig) {
    try {
      const base = normalizeBaseUrl((next.base_url || "").trim());
      const restart_times = parseRestartTimes(restartTimesText);
      // Send both snake_case and camelCase for maximum compatibility with older binaries
      const payload: any = {
        base_url: base,
        baseUrl: base,
        password: next.password || null,
        restart_times,
        restartTimes: restart_times,
        start_cmd: startCmd || null,
        startCmd: startCmd || null,
        backup_dir: backupDir || null,
        backupDir: backupDir || null,
        backup_dest_dir: backupDestDir || null,
        backupDestDir: backupDestDir || null,
        discord_webhook: (discordHook || null),
        discordWebhook: (discordHook || null),
      };
      try {
        // helpful debug entry to verify the active bundle
        const keys = Object.keys(payload).join(", ");
        pushLog(`set_config payload keys -> ${keys}`);
      } catch {}
      await invoke("set_config", payload);
      setCfg({ ...next, base_url: base, restart_times });
      setRestartTimesText(restart_times.join(", "));
      pushLog(`Config applied. Base: ${base}${restart_times.length ? ` | restarts: ${restart_times.join(",")}` : ""}`);
      // remember last applied snapshot
      lastAppliedRef.current = `${base}|${next.password || ""}|${restart_times.join(",")}|${startCmd || ""}|${backupDir || ""}|${backupDestDir || ""}|${discordHook || ""}`;
      await refreshAll();
    } catch (e: any) {
      pushLog(`Apply failed: ${e?.toString?.() || e}`);
    }
  }

  async function checkConnection() {
    setConnStatus(null);
    try {
      const info = await invoke("get_server_info");
      setConnStatus({ ok: true, msg: "Connected" });
      pushLog("Connection OK");
    } catch (e: any) {
      const msg = e?.toString?.() || String(e);
      setConnStatus({ ok: false, msg });
      pushLog(`Connection failed: ${msg}`);
    }
  }

  async function refreshAll() {
    if (!cfg.base_url) return;
    // Skip if we're inside a restart/shutdown cool-down window
    if (Date.now() < refreshHoldUntil) return;
    try {
      const info = (await invoke("get_server_info")) as {
        name: string;
        map?: string | null;
        players_online: number;
        uptime_seconds?: number | null;
      };
      setServerName(info?.name || "?");
      setPlayersCount(info?.players_online || 0);
      setUptime(info?.uptime_seconds ?? null);
      pushLog("Refreshed server info/players");
      setLiveConn({ ok: true });
    } catch (e: any) {
      const msg = e?.toString?.() || e;
      pushLog(`Refresh failed: GET info/players -> ${msg}`);
      setLiveConn({ ok: false, msg: String(msg) });
      // If the server is offline/refusing connections, pause refreshes for 60s
      const text = String(msg).toLowerCase();
      if (text.includes("actively refused") || text.includes("connection refused") || text.includes("failed to connect") || text.includes("timed out")) {
        const until = Date.now() + 60_000;
        setRefreshHoldUntil(until);
        pushLog("Pausing refresh for 60s after connection failure");
      }
    }

    try {
      const list = (await invoke("get_players")) as Player[];
      setPlayers(list || []);
      // keep the Players stat in sync with the visible list
      setPlayersCount(Array.isArray(list) ? list.length : 0);
      // client-side join/leave log with names
      const prev = prevPlayersRef.current;
      const nextMap = new Map<string, string>();
      for (const p of list || []) nextMap.set(p.id, p.name || p.id);
      // joined
      for (const [id, name] of nextMap) {
        if (!prev.has(id)) pushLog(`Player joined: ${name}`);
      }
      // left
      for (const [id, name] of prev) {
        if (!nextMap.has(id)) pushLog(`Player left: ${name}`);
      }
      prevPlayersRef.current = nextMap;
    } catch {
      /* already logged */
    }
  }

  async function onBroadcast() {
    const msg = broadcastMsg.trim();
    if (!msg) return;
    try {
      await invoke("announce_message", { message: msg });
      pushLog(`Broadcast: "${msg}"`);
      setBroadcastMsg("");
      setBroadcastOpen(false);
    } catch (e: any) {
      pushLog(`Broadcast failed: ${e?.toString?.() || e}`);
    }
  }

  async function onSave() {
    if (saving) return;
    setSaving(true);
    pushLog("Save started...");
    try {
      const res = (await invoke("force_save")) as string;
      pushLog(`Save dispatched: ${res}`);
    } catch (e: any) {
      pushLog(`Save failed: ${e?.toString?.() || e}`);
    } finally {
      setTimeout(() => setSaving(false), 8000);
    }
  }

  const hasPlayers = (players?.length ?? 0) > 0;
  const [shutdownSecs, setShutdownSecs] = useState<number>(60);

  function steamIdOf(id: string): string | null {
    const m = (id || '').match(/\d{17}/);
    return m ? m[0] : null;
  }

  async function onKick(id: string) {
    try {
      await invoke("kick_player", { playerId: id });
      pushLog(`Kick requested for ${id}`);
      await refreshAll();
    } catch (e: any) {
      pushLog(`Kick failed: ${e?.toString?.() || e}`);
    }
  }
  async function onBan(id: string) {
    try {
      await invoke("ban_player", { playerId: id });
      pushLog(`Ban requested for ${id}`);
      await refreshAll();
    } catch (e: any) {
      pushLog(`Ban failed: ${e?.toString?.() || e}`);
    }
  }

  return (
    <div className="container">
      {/* Top bar */}
      <div className="navbar">
        <div className="title">Palworld Rest API Client</div>
        <div className="row">
          {liveConn && (
            <span className={`chip ${liveConn.ok ? 'ok' : 'err'}`} title={liveConn.msg || ''}>
              <span className={`dot ${liveConn.ok ? 'ok' : 'err'}`} />
              {liveConn.ok ? 'Online' : 'Offline'}
            </span>
          )}
          {restartCountdown != null && (
            <span className="chip" title="Pending restart">
              <span className="dot ok" /> Restart in {restartCountdown}s
            </span>
          )}
          <button className="btn btn-gray" onClick={() => setSettingsOpen(true)}>Settings</button>
          <button className="btn btn-gray" onClick={refreshAll}>Refresh</button>
        </div>
      </div>

      {/* Stats */}
      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-label">Name</div>
          <div className="stat-value">{serverName}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Players</div>
          <div className="stat-value">{playersCount}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Uptime</div>
          <div className="stat-value">{fmtUptime(uptime)}</div>
        </div>
      </div>

      {/* Actions + Players (single section) */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="section-title">Server Actions</div>
        {allowActions && (
          <div className="panel" style={{ marginBottom: 10 }}>
            <div className="row">
              <button className="btn btn-green" onClick={() => setBroadcastOpen(true)}>Broadcast</button>
              <button className="btn btn-blue" onClick={onSave} disabled={saving}>
                {saving ? "Saving..." : "Force Save"}
              </button>
              <button className="btn btn-gray" onClick={refreshAll}>Refresh Players</button>
              <button className="btn btn-blue" onClick={() => setTimeModal({ kind: "restart", seconds: shutdownSecs })}>Restart</button>
              <button className="btn btn-gray" onClick={async () => { try { await invoke('cancel_restart'); setRestartCountdown(null); pushLog('Pending restart canceled'); } catch (e:any) { pushLog(`Cancel failed: ${e?.toString?.()||e}`);} }}>Cancel Restart</button>
              <button className="btn btn-red" onClick={() => setTimeModal({ kind: "shutdown", seconds: shutdownSecs })}>Shutdown</button>
              {restartCountdown != null && (
                <span className="chip" title="Pending restart">
                  <span className="dot ok" /> Restart in {restartCountdown}s
                </span>
              )}
            </div>
          </div>
        )}

        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Steam ID</th>
              <th>Lvl</th>
              <th>Ping</th>
              <th>Connected</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {!hasPlayers && (
              <tr>
                <td colSpan={5} style={{ color: "#94a3b8" }}>No players online</td>
              </tr>
            )}
            {players.map((p) => (
              <tr key={p.id}>
                <td>{p.name || "Unknown"}</td>
                <td>{steamIdOf(p.id) || "—"}</td>
                <td>{p.level ?? "?"}</td>
                <td>{p.ping ?? "?"}</td>
                <td>{fmtConnectedSeconds(p.connected_seconds)}</td>
                <td>
                  <div className="row">
                    <button className="btn btn-gray" onClick={() => { const id = steamIdOf(p.id) || p.id; navigator.clipboard.writeText(id); pushLog(`Copied ID for ${p.name || id}`); }}>Copy ID</button>
                    <button className="btn btn-gray" onClick={() => onKick(steamIdOf(p.id) || p.id)}>Kick</button>
                    <button className="btn btn-red" onClick={() => onBan(steamIdOf(p.id) || p.id)}>Ban</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Logs */}
      <div className="card">
        <div className="section-title">Logs</div>
        <div className="panel logs">
          {logs.length === 0 ? (
            <div style={{ color: "#94a3b8" }}>No logs yet.</div>
          ) : (
            logs.map((l, i) => {
              const lower = l.toLowerCase();
              const isErr = lower.includes("failed") || lower.includes("error");
              return (
                <div key={i} className={isErr ? "log-line log-error" : "log-line"}>{l}</div>
              );
            })
          )}
        </div>
      </div>

      {/* Settings Modal */}
      {settingsOpen && (
        <Modal onClose={() => setSettingsOpen(false)} title="Settings">
          <div className="row" style={{ marginBottom: 8 }}>
            <div className="fill">
              <div style={{ fontSize: 12, color: "#cbd5e1", marginBottom: 4 }}>Server URL</div>
              <input
                className="pill input"
                value={cfg.base_url}
                onChange={(e) => setCfg((c) => ({ ...c, base_url: e.target.value }))}
                placeholder="45.141.24.11:8212  (or http://45.141.24.11:8212)"
              />
            </div>
          </div>
          <div className="row" style={{ marginBottom: 8 }}>
            <div className="fill">
              <div style={{ fontSize: 12, color: "#cbd5e1", marginBottom: 4 }}>Admin password</div>
              <input
                type="password"
                className="pill input"
                value={cfg.password || ""}
                onChange={(e) => setCfg((c) => ({ ...c, password: e.target.value }))}
              />
            </div>
          </div>
          <div className="row" style={{ marginBottom: 8 }}>
            <div className="fill">
              <div style={{ fontSize: 12, color: "#cbd5e1", marginBottom: 4 }}>Start command (.bat or .exe)</div>
              <input
                className="pill input"
                value={startCmd}
                onChange={(e) => setStartCmd(e.target.value)}
                placeholder="C:\\palworldserver\\start-palworld.bat"
              />
            </div>
          </div>
          <div className="row" style={{ marginBottom: 8 }}>
            <div className="fill">
              <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="checkbox" checked={allowActions} onChange={(e)=>setAllowActions(e.target.checked)} />
                Allow actions from this device (read-only when off)
              </label>
            </div>
          </div>
          <div className="row" style={{ marginBottom: 12 }}>
            <div className="fill">
              <div style={{ fontSize: 12, color: "#cbd5e1", marginBottom: 4 }}>Backups</div>
              <button className="btn btn-gray" onClick={() => setBackupsOpen(true)}>Open Backups</button>
            </div>
          </div>
          <div className="row" style={{ marginBottom: 12 }}>
            <div className="fill">
              <div style={{ fontSize: 12, color: "#cbd5e1", marginBottom: 4 }}>Restart times (HH:MM, comma-separated)</div>
              <input
                className="pill input"
                value={restartTimesText}
                onChange={(e) => setRestartTimesText(e.target.value)}
                placeholder="03:00, 09:00, 15:00, 21:00"
              />
            </div>
          </div>
          <div className="row" style={{ marginBottom: 12 }}>
            <div className="fill">
              <div style={{ fontSize: 12, color: "#cbd5e1", marginBottom: 4 }}>Discord Webhook URL (optional)</div>
              <input
                className="pill input"
                value={discordHook}
                onChange={(e) => setDiscordHook(e.target.value)}
                placeholder="https://discord.com/api/webhooks/..."
              />
            </div>
          </div>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <button className="btn btn-gray" onClick={checkConnection}>Check Connection</button>
              <button
                className="btn btn-gray"
                onClick={async () => {
                  try {
                    const raw = await invoke<string>('dump_players_json');
                    pushLog('PLAYERS JSON:\n' + raw);
                  } catch (e:any) {
                    pushLog('Dump players failed: ' + (e?.toString?.()||e));
                  }
                }}
                style={{ marginLeft: 8 }}
              >
                Dump Players JSON
              </button>
              {connStatus && (
                <span style={{ marginLeft: 10, color: connStatus.ok ? '#86efac' : '#fca5a5' }}>
                  {connStatus.ok ? 'OK' : 'Failed'}{connStatus.msg ? `: ${connStatus.msg}` : ''}
                </span>
              )}
            </div>
            <button className="btn btn-blue" onClick={() => applySettings({ ...cfg, base_url: cfg.base_url.trim() })}>Apply</button>
          </div>
        </Modal>
      )}

      {/* Broadcast Modal */}
      {broadcastOpen && (
        <Modal title="Broadcast" onClose={() => setBroadcastOpen(false)}>
          <div className="row">
            <input
              className="pill input fill"
              value={broadcastMsg}
              onChange={(e) => setBroadcastMsg(e.target.value)}
              placeholder="Type a message to announce..."
            />
            <button className="btn btn-green" onClick={onBroadcast}>Send</button>
          </div>
        </Modal>
      )}

      {/* Time Modal for Restart/Shutdown */}
      {timeModal && (
        <Modal title={timeModal.kind === 'restart' ? 'Schedule Restart' : 'Schedule Shutdown'} onClose={() => setTimeModal(null)}>
          <div className="row">
            <input
              className="pill input"
              style={{ width: 120, textAlign: 'center' }}
              type="number"
              min={0}
              value={timeModal.seconds}
              onChange={(e) => setTimeModal((m) => (m ? { ...m, seconds: Math.max(0, Number(e.target.value) || 0) } : m))}
            />
            <button
              className="btn btn-blue"
              onClick={async () => {
                const modal = timeModal;
                if (!modal) return;
                setTimeModal(null); // close immediately on confirm
                try {
                  if (modal.kind === 'restart') {
                    await invoke('restart_now', { seconds: modal.seconds });
                    setRestartCountdown(modal.seconds);
                    pushLog(`Restart requested (${modal.seconds}s lead time)`);
                    // Hold refresh starting now until some time after the scheduled restart finishes
                    setRefreshHoldUntil(Date.now() + (modal.seconds + 60) * 1000);
                  } else {
                    await invoke('shutdown_server', { seconds: modal.seconds, msg: 'Server restarting...' });
                    pushLog(`Shutdown requested (${modal.seconds}s)`);
                    setRefreshHoldUntil(Date.now() + (modal.seconds + 60) * 1000);
                  }
                } catch (e: any) {
                  pushLog(`${modal.kind} failed: ${e?.toString?.() || e}`);
                }
              }}
            >
              Confirm
            </button>
          </div>
        </Modal>
      )}

      {backupsOpen && (
        <Modal title="Backups" onClose={() => setBackupsOpen(false)}>
          <div className="row" style={{ marginBottom: 8 }}>
            <div className="fill">
              <div style={{ fontSize: 12, color: '#cbd5e1', marginBottom: 4 }}>Backup source folder</div>
              <div className="row">
                <input className="pill input fill" value={backupDir} onChange={(e)=>setBackupDir(e.target.value)} placeholder="C:\\path\\to\\source" />
                <button className="btn btn-gray" onClick={async ()=>{
                  const sel = await openDialog({ directory: true, multiple: false });
                  if (typeof sel === 'string') setBackupDir(sel);
                }}>Pick</button>
              </div>
            </div>
          </div>
          <div className="row" style={{ marginBottom: 8 }}>
            <div className="fill">
              <div style={{ fontSize: 12, color: '#cbd5e1', marginBottom: 4 }}>Backup destination folder</div>
              <div className="row">
                <input className="pill input fill" value={backupDestDir} onChange={(e)=>setBackupDestDir(e.target.value)} placeholder="C:\\path\\to\\destination" />
                <button className="btn btn-gray" onClick={async ()=>{
                  const sel = await openDialog({ directory: true, multiple: false });
                  if (typeof sel === 'string') setBackupDestDir(sel);
                }}>Pick</button>
              </div>
            </div>
          </div>
          <div className="row" style={{ justifyContent:'space-between', alignItems:'center' }}>
            <button className="btn btn-blue" onClick={async ()=>{
              try {
                const path = await invoke<string>('backup_now', { srcOverride: backupDir || null, destOverride: backupDestDir || null });
                pushLog(`Backup created: ${path}`);
              } catch(e:any) {
                pushLog(`Backup failed: ${e?.toString?.()||e}`);
              }
            }}>Backup Now</button>
            <button className="btn btn-gray" onClick={()=> setBackupsOpen(false)}>Done</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div onClick={onClose} style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.6)" }} />
      <div className="card" style={{ width: "min(720px,92vw)", position: "relative" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <h3 style={{ fontSize: 18, fontWeight: 600 }}>{title}</h3>
          <button className="btn btn-gray" onClick={onClose}>Close</button>
        </div>
        {children}
      </div>
    </div>
  );
}
