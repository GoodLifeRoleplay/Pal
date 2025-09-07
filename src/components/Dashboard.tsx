import React, { useEffect, useMemo, useRef, useState } from "react";
import { tInvoke, bridgeAvailable } from "../lib/tauribridge";

type Player = { id: string; name: string; level?: number; ping?: number };
type ServerInfo = {
  name: string;
  map?: string | null;
  players_online: number;
  max_players?: number | null;
  uptime_seconds?: number | null;
};

const card: React.CSSProperties = {
  background: "#121821",
  border: "1px solid #1f2a37",
  borderRadius: 12,
  padding: 12,
  marginBottom: 16,
};
const input: React.CSSProperties = {
  width: "100%",
  padding: 8,
  borderRadius: 8,
  border: "1px solid #253041",
  background: "#0b1017",
  color: "#e5e7eb",
  outline: "none",
};
const btnBase: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: 10,
  border: "1px solid #314155",
  background: "#0b1118",
  color: "#e5e7eb",
  cursor: "pointer",
  userSelect: "none",
};
const btn = btnBase;
const btnDanger: React.CSSProperties = { ...btnBase, borderColor: "#57333a" };
const th: React.CSSProperties = { textAlign: "left", borderBottom: "1px solid #233042", padding: "6px 4px" };
const td: React.CSSProperties = { borderBottom: "1px solid #192432", padding: "6px 4px", fontSize: 14 };
const grid2: React.CSSProperties = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 };

export default function Dashboard() {
  // You can type just host:port or the full .../v1/api – Rust will normalize either.
  const [baseUrl, setBaseUrl] = useState("http://45.141.24.11:8212/v1/api");
  const [password, setPassword] = useState("Papsmells");

  const [tauriMissing, setTauriMissing] = useState(false);
  const [server, setServer] = useState<ServerInfo | null>(null);
  const [players, setPlayers] = useState<Player[]>([]);
  const [durations, setDurations] = useState<Record<string, number>>({});
  const [msg, setMsg] = useState("");
  const [saveDir, setSaveDir] = useState("C:\\palworldserver\\Pal\\Saved\\SaveGames");
  const [startCmd, setStartCmd] = useState("");
  const [intervalMin, setIntervalMin] = useState(240);

  const [log, setLog] = useState<string[]>([]);
  const logRef = useRef<HTMLDivElement | null>(null);

  function pushLog(line: string) {
    const time = new Date().toLocaleTimeString();
    setLog((l) => [`[${time}] ${line}`, ...l].slice(0, 800));
  }

  function fmtSecs(s?: number | null) {
    if (s == null) return "";
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return [h ? `${h}h` : "", m ? `${m}m` : "", `${sec}s`].filter(Boolean).join(" ");
  }

  const rows = useMemo(
    () => players.map((p) => ({ ...p, duration: fmtSecs(durations[p.id] ?? 0) })),
    [players, durations]
  );

  useEffect(() => {
    bridgeAvailable().then((ok) => setTauriMissing(!ok));
  }, []);

  // Explicit "Apply" button so we *know* config is set.
  async function applyConfig() {
    try {
      await tInvoke("set_config", { base_url: baseUrl, baseUrl: baseUrl, password: password || null });
      const cfg = await tInvoke<{ base_url: string; password: string | null }>("get_config");
      pushLog(`Config applied. Base: ${cfg.base_url}`);
      setTauriMissing(false);
    } catch (e: any) {
      setTauriMissing(true);
      pushLog(`Bridge/config error: ${e?.message || e}`);
    }
  }

  // Poll every 5s
  useEffect(() => {
    let stop = false;
    async function refresh() {
      try {
        const s: ServerInfo = await tInvoke("get_server_info");
        if (!stop) setServer(s);
      } catch (e: any) {
        pushLog(`Server info failed: ${e?.message || e}`);
      }
      try {
        const p: Player[] = await tInvoke("get_players");
        const d: Record<string, number> = await tInvoke("player_durations").then(res => res as Record<string, number>).catch(() => ({}));
        if (!stop) {
          setPlayers(p);
          setDurations(d || {});
          // pushLog("Refreshed server info/players");
        }
      } catch (e: any) {
        pushLog(`Players failed: ${e?.message || e}`);
      }
    }
    refresh();
    const t = setInterval(refresh, 10000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);

  async function onBroadcast() {
    try {
      await tInvoke("announce_message", { message: msg });
      pushLog("Broadcast sent");
      setMsg("");
    } catch (e: any) {
      pushLog(`Broadcast failed: ${e?.message || e}`);
    }
  }
const [saving, setSaving] = useState(false);

async function onSave() {
  if (saving) return;
  setSaving(true);
  try {
    const msg: string = await tInvoke("force_save");
    pushLog(`Save: ${msg} (watch chat for “Saving world…” / “Game saved”)`);
  } catch (e: any) {
    pushLog(`Save failed to dispatch: ${e?.message ?? e}`);
  } finally {
    setSaving(false);
  }
}


  async function onShutdown() {
    try {
      await tInvoke("shutdown_server", { seconds: 60, msg: "Server restarting..." });
      pushLog("Shutdown in 60s");
    } catch (e: any) {
      pushLog(`Shutdown failed: ${e?.message || e}`);
    }
  }
  async function onBackup() {
    try {
      const zipPath: string = await tInvoke("backup_now", { save_dir: saveDir, saveDir: saveDir });
      pushLog(`Backup created: ${zipPath}`);
    } catch (e: any) {
      pushLog(`Backup failed: ${e?.message || e}`);
    }
  }
  async function onStartAuto() {
    try {
      await tInvoke("start_auto_restart", { minutes: Number(intervalMin) });
      pushLog(`Auto-restart ON (every ${intervalMin} min)`);
    } catch (e: any) {
      pushLog(`Auto-restart failed: ${e?.message || e}`);
    }
  }
  async function onStopAuto() {
    try {
      await tInvoke("stop_auto_restart");
      pushLog("Auto-restart OFF");
    } catch (e: any) {
      pushLog(`Stop failed: ${e?.message || e}`);
    }
  }

  return (
    <div style={{ padding: 12, color: "#e5e7eb", fontFamily: "Inter, ui-sans-serif, system-ui" }}>
      <h1 style={{ fontSize: 24, marginBottom: 12 }}>Palworld Control</h1>
      {tauriMissing && (
        <div style={{ marginBottom: 12, fontSize: 12, color: "#f59e0b" }}>
          Tauri bridge not available — launch with <code>npx tauri dev</code>
        </div>
      )}

      {/* Server */}
      <div style={card}>
        <div style={grid2}>
          <div>
            <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 6 }}>server URL</div>
            <input style={input} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          </div>
          <div>
            <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 6 }}>Password</div>
            <input style={input} value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
        </div>
        <div style={{ marginTop: 8 }}>
          <button style={btn} onClick={applyConfig}>Apply</button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8, marginTop: 12 }}>
          <div>Name: {server?.name ?? "—"}</div>
          <div>Players: {server ? `${server.players_online}${server.max_players ? ` / ${server.max_players}` : ""}` : "—"}</div>
          <div>Map: {server?.map ?? "—"}</div>
          <div>Uptime: {fmtSecs(server?.uptime_seconds ?? undefined) || "—"}</div>
        </div>
      </div>

      {/* Broadcast & Actions */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div style={card}>
          <div style={{ marginBottom: 8, fontSize: 18 }}>Broadcast & Actions</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8 }}>
            <input style={input} placeholder="message..." value={msg} onChange={(e) => setMsg(e.target.value)} />
            <button style={btn} onClick={onBroadcast}>Send</button>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button style={btn} onClick={onSave} disabled={saving}>{saving ? "Saving..." : "Save"}</button>
            <button style={btn} onClick={() => pushLog("Manual refresh requested")}>Refresh Players</button>
            <button style={btnDanger} onClick={onShutdown}>Shutdown</button>
          </div>
        </div>

        <div style={card}>
          <div style={{ marginBottom: 8, fontSize: 18 }}>Auto-Restart & Backups</div>
          <div style={grid2}>
            <div>
              <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 6 }}>Save Dir</div>
              <input style={input} value={saveDir} onChange={(e) => setSaveDir(e.target.value)} />
            </div>
            <div>
              <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 6 }}>Interval (min)</div>
              <input
                style={input}
                type="number"
                value={intervalMin}
                onChange={(e) => setIntervalMin(Number(e.target.value || 0))}
              />
            </div>
          </div>
          <div>
            <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 6 }}>Start Command (optional, runs after shutdown)</div>
            <input style={input} value={startCmd} onChange={(e) => setStartCmd(e.target.value)} />
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button style={btn} onClick={onBackup}>Backup Now</button>
            <button style={btn} onClick={onStartAuto}>Start Auto-Restart</button>
            <button style={btnDanger} onClick={onStopAuto}>Stop</button>
          </div>
        </div>
      </div>

      {/* Players */}
      <div style={card}>
        <div style={{ marginBottom: 8, fontSize: 18 }}>Players</div>
        {rows.length === 0 ? (
          <div style={{ opacity: 0.7, fontSize: 14 }}>No players online</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Name</th>
                <th style={th}>ID</th>
                <th style={th}>Lvl</th>
                <th style={th}>Ping</th>
                <th style={th}>Connected</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  <td style={td}>{p.name}</td>
                  <td style={td}>{p.id.slice(0, 10)}…</td>
                  <td style={td}>{p.level ?? "-"}</td>
                  <td style={td}>{p.ping ?? "-"}</td>
                  <td style={td}>{(p as any).duration}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Logs */}
      <div style={card}>
        <div style={{ marginBottom: 8, fontSize: 18 }}>Logs</div>
        <div ref={logRef} style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", whiteSpace: "pre-wrap", background: "#0d121a", border: "1px solid #1f2a37", borderRadius: 8, padding: 8, height: 280, overflow: "auto" }}>
          {log.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      </div>
    </div>
  );
}
