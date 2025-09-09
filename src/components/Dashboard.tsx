import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { normalizeBaseUrl } from "../lib/url";

type ApiConfig = {
  base_url: string;
  password?: string | null;
  restart_times?: string[];
  start_cmd?: string | null;
  backup_dir?: string | null;
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
  const [discordHook, setDiscordHook] = useState<string>("");
  const [connStatus, setConnStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [liveConn, setLiveConn] = useState<{ ok: boolean; msg?: string } | null>(null);
  const [restartCountdown, setRestartCountdown] = useState<number | null>(null);
  const restartTimerRef = React.useRef<number | null>(null);
  const [unbanOpen, setUnbanOpen] = useState(false);
  const [unbanId, setUnbanId] = useState("");

  const pushLog = (line: string) => setLogs((prev) => [...prev.slice(-400), `[${ts()}] ${line}`]);

  // load config from backend on mount
  useEffect(() => {
    (async () => {
      try {
        const c = (await invoke("get_config")) as ApiConfig;
        const base_url = (c?.base_url || "").trim();
        const password = c?.password ?? "";
        setCfg({ base_url, password, restart_times: c.restart_times ?? [], start_cmd: c.start_cmd ?? null, backup_dir: c.backup_dir ?? null });
        setRestartTimesText((c.restart_times ?? []).join(", "));
        setStartCmd(c.start_cmd || "");
        setBackupDir(c.backup_dir || "");
        setDiscordHook((c as any).discord_webhook || (c as any).discordWebhook || "");
        pushLog(`Loaded settings. Base: ${base_url || "(not set)"}`);
        if (base_url) await refreshAll();
      } catch (e: any) {
        pushLog(`Failed to load settings: ${e?.toString?.() || e}`);
      }
    })();
  }, []);

  // periodic refresh (every 30s)
  useEffect(() => {
    if (!cfg.base_url) return;
    const id = setInterval(() => {
      refreshAll();
    }, 30_000);
    return () => clearInterval(id);
  }, [cfg.base_url]);

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
    }

    try {
      const list = (await invoke("get_players")) as Player[];
      setPlayers(list || []);
      // keep the Players stat in sync with the visible list
      setPlayersCount(Array.isArray(list) ? list.length : 0);
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
    return /^\d{17}$/.test(id) ? id : null;
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
        <div className="panel" style={{ marginBottom: 10 }}>
          <div className="row">
            <button className="btn btn-green" onClick={() => setBroadcastOpen(true)}>Broadcast</button>
            <button className="btn btn-blue" onClick={onSave} disabled={saving}>
              {saving ? "Saving..." : "Force Save"}
            </button>
            <button className="btn btn-gray" onClick={refreshAll}>Refresh Players</button>
            <button className="btn btn-blue" onClick={() => setTimeModal({ kind: "restart", seconds: shutdownSecs })}>Restart</button>
            <button className="btn btn-gray" onClick={async () => { try { await invoke('cancel_restart'); setRestartCountdown(null); pushLog('Pending restart canceled'); } catch (e:any) { pushLog(`Cancel failed: ${e?.toString?.()||e}`);} }}>Cancel Restart</button>
            <button className="btn btn-gray" onClick={() => setUnbanOpen(true)}>Unban</button>
            <button className="btn btn-red" onClick={() => setTimeModal({ kind: "shutdown", seconds: shutdownSecs })}>Shutdown</button>
          </div>
        </div>

        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Steam ID</th>
              <th>Lvl</th>
              <th>Ping</th>
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
          <div className="row" style={{ marginBottom: 12 }}>
            <div className="fill">
              <div style={{ fontSize: 12, color: "#cbd5e1", marginBottom: 4 }}>Backup directory (optional)</div>
              <input
                className="pill input"
                value={backupDir}
                onChange={(e) => setBackupDir(e.target.value)}
                placeholder="C:\\palworldserver\\backups"
              />
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
                if (!timeModal) return;
                try {
                  if (timeModal.kind === 'restart') {
                    await invoke('restart_now', { seconds: timeModal.seconds });
                    setRestartCountdown(timeModal.seconds);
                    pushLog(`Restart requested (${timeModal.seconds}s lead time)`);
                  } else {
                    await invoke('shutdown_server', { seconds: timeModal.seconds, msg: 'Server restarting...' });
                    pushLog(`Shutdown requested (${timeModal.seconds}s)`);
                  }
                  setTimeModal(null);
                } catch (e: any) {
                  pushLog(`${timeModal.kind} failed: ${e?.toString?.() || e}`);
                }
              }}
            >
              Confirm
            </button>
          </div>
        </Modal>
      )}

      {unbanOpen && (
        <Modal title="Unban Player" onClose={() => setUnbanOpen(false)}>
          <div className="row">
            <input
              className="pill input fill"
              value={unbanId}
              onChange={(e) => setUnbanId(e.target.value)}
              placeholder="Enter Steam ID to unban"
            />
            <button
              className="btn btn-blue"
              onClick={async () => {
                const id = unbanId.trim();
                if (!id) return;
                try {
                  await invoke('unban_player', { playerId: id });
                  pushLog(`Unban requested for ${id}`);
                  setUnbanOpen(false);
                  setUnbanId("");
                } catch (e:any) {
                  pushLog(`Unban failed: ${e?.toString?.()||e}`);
                }
              }}
            >
              Confirm
            </button>
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
