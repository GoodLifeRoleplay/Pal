import React, { useEffect, useMemo, useRef, useState } from "react";
import { tInvoke, bridgeAvailable } from "../lib/tauriBridge";

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
  width: "100%", padding: 8, borderRadius: 8, border: "1px solid #253041",
  background: "#0b1017", color: "#e5e7eb", outline: "none"
};
const btnBase: React.CSSProperties = {
  padding: "8px 12px", borderRadius: 10, border: "1px solid #314155",
  background: "#0b1118", color: "#e5e7eb", cursor: "pointer", userSelect: "none"
};
const btn = btnBase;
const btnDanger: React.CSSProperties = { ...btnBase, borderColor: "#57333a" };
const th: React.CSSProperties = { textAlign: "left", borderBottom: "1px solid #233042", padding: "6px 4px" };
const td: React.CSSProperties = { borderBottom: "1px solid #192432", padding: "6px 4px", fontSize: 14 };
const grid2: React.CSSProperties = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 };

export default function Dashboard() {
  const [baseUrl, setBaseUrl] = useState("http://45.141.24.11:8212/v1/api");
  const [token, setToken] = useState("Papsmells");
  const [tauriMissing, setTauriMissing] = useState(false);

  const [server, setServer] = useState<ServerInfo | null>(null);
  const [players, setPlayers] = useState<Player[]>([]);
  const [durations, setDurations] = useState<Record<string, number>>({});

  const [msg, setMsg] = useState("");
  const [saveDir, setSaveDir] = useState("C:\\\\palworldserver\\\\Pal\\Saved\\SaveGames");
  const [startCmd, setStartCmd] = useState("");
  const [intervalMin, setIntervalMin] = useState(240);

  const [log, setLog] = useState<string[]>([]);
  const logRef = useRef<HTMLDivElement | null>(null);

  function pushLog(line: string) {
    const time = new Date().toLocaleTimeString();
    setLog(l => [`[${time}] ${line}`, ...l].slice(0, 600));
  }
  function fmtSecs(s?: number | null) {
    if (s == null) return "";
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return [h ? `${h}h` : "", m ? `${m}m` : "", `${sec}s`].filter(Boolean).join(" ");
  }
  const rows = useMemo(
    () => players.map(p => ({ ...p, duration: fmtSecs(durations[p.id] ?? 0) })),
    [players, durations]
  );

  // Detect bridge once on mount (UI badge)
  useEffect(() => {
    bridgeAvailable().then(ok => setTauriMissing(!ok));
  }, []);

  // Apply API config whenever URL/token changes
  useEffect(() => {
    (async () => {
      try {
        await tInvoke("set_config", { base_url: baseUrl, password: token || null });
        pushLog(`REST route: "${baseUrl}"`);
        setTauriMissing(false);
      } catch (e: any) {
        setTauriMissing(true);
        pushLog(`Bridge/config error: ${e?.message || e}`);
      }
    })();
  }, [baseUrl, token]);

  // Poll server info + players every 5s
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
        const d: Record<string, number> = await tInvoke("player_durations");
        if (!stop) {
          setPlayers(p);
          setDurations(d);
          pushLog("Refreshed server info/players");
        }
      } catch (e: any) {
        pushLog(`Players failed: ${e?.message || e}`);
      }
    }
    refresh();
    const t = setInterval(refresh, 5000);
    return () => { stop = true; clearInterval(t); };
  }, []);

  async function onBroadcast() {
    try { await tInvoke("announce_message", { message: msg });
 pushLog("Broadcast sent"); setMsg(""); }
    catch (e: any) { pushLog(`Broadcast failed: ${e?.message || e}`); }
  }
  async function onSave() {
    try { await tInvoke("force_save"); pushLog("Save triggered"); }
    catch (e: any) { pushLog(`Save failed: ${e?.message || e}`); }
  }
  async function onShutdown() {
    try { await tInvoke("shutdown_server", { seconds: 60, msg: "Server restarting..." }); pushLog("Shutdown in 60s"); }
    catch (e: any) { pushLog(`Shutdown failed: ${e?.message || e}`); }
  }
  async function onBackup() {
    try { const zipPath: string = await tInvoke("backup_now", { save_dir: saveDir }); pushLog(`Backup created: ${zipPath}`); }
    catch (e: any) { pushLog(`Backup failed: ${e?.message || e}`); }
  }
  async function onStartAuto() {
    try {
      await tInvoke("start_auto_restart", { minutes: Number(intervalMin) });
      pushLog(`Auto-restart ON (every ${intervalMin} min)`);
    } catch (e: any) { pushLog(`Auto-restart failed: ${e?.message || e}`); }
  }
  async function onStopAuto() {
    try { await tInvoke("stop_auto_restart"); pushLog("Auto-restart OFF"); }
    catch (e: any) { pushLog(`Stop failed: ${e?.message || e}`); }
  }

  return (
    <div style={{ padding: 16, color: "#d7dae0", background: "#0f141a", minHeight: "100vh" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
        <h2 style={{ margin: 0 }}>Palworld Control</h2>
        {tauriMissing && (
          <span style={{ fontSize: 13, padding: "2px 8px", borderRadius: 6,
            background: "#3b2f1a", border: "1px solid #6b4e21", color: "#ffde9c" }}>
            Tauri bridge not available — launch with <code>npx tauri dev</code>
          </span>
        )}
      </div>

      <div style={card}>
        <h3 style={{ marginTop: 0 }}>Server</h3>
        <div style={grid2}>
          <label>server URL
            <input style={input} value={baseUrl} onChange={e => setBaseUrl(e.target.value)} />
          </label>
          <label>Password
            <input style={input} value={token} onChange={e => setToken(e.target.value)} />
          </label>
        </div>
        <div style={{ marginTop: 8, opacity: 0.9, display: "grid", gridTemplateColumns: "repeat(4, minmax(0,1fr))", gap: 8 }}>
          <div><b>Name:</b> {server?.name ?? "—"}</div>
          <div><b>Players:</b> {server ? `${server.players_online}${server.max_players ? ` / ${server.max_players}` : ""}` : "—"}</div>
          <div><b>Map:</b> {server?.map ?? "—"}</div>
          <div><b>Uptime:</b> {fmtSecs(server?.uptime_seconds ?? undefined) || "—"}</div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div style={card}>
          <h3 style={{ marginTop: 0 }}>Broadcast & Actions</h3>
          <div style={{ display: "flex", gap: 8 }}>
            <input style={{ ...input, flex: 1 }} placeholder="message…" value={msg} onChange={(e) => setMsg(e.target.value)} />
            <button style={btn} onClick={onBroadcast}>Send</button>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button style={btn} onClick={onSave}>Save</button>
            <button style={btn} onClick={() => pushLog("Manual refresh requested")}>Refresh Players</button>
            <button style={btnDanger} onClick={onShutdown}>Shutdown</button>
          </div>
        </div>

        <div style={card}>
          <h3 style={{ marginTop: 0 }}>Auto-Restart & Backups</h3>
          <div style={grid2}>
            <label>Save Dir
              <input style={input} value={saveDir} onChange={e => setSaveDir(e.target.value)} />
            </label>
            <label>Interval (min)
              <input style={input} type="number" min={1} value={intervalMin} onChange={e => setIntervalMin(Number(e.target.value || 0))} />
            </label>
          </div>
          <label>Start Command (optional, runs after shutdown)
            <input style={input} placeholder='e.g. C:\palworldserver\start-palworld.bat' value={startCmd} onChange={e => setStartCmd(e.target.value)} />
          </label>
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button style={btn} onClick={onBackup}>Backup Now</button>
            <button style={btn} onClick={onStartAuto}>Start Auto-Restart</button>
            <button style={btn} onClick={onStopAuto}>Stop</button>
          </div>
        </div>
      </div>

      <div style={card}>
        <h3 style={{ marginTop: 0 }}>Players</h3>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr><th style={th}>Name</th><th style={th}>ID</th><th style={th}>Lvl</th><th style={th}>Ping</th><th style={th}>Connected</th></tr>
          </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td style={td} colSpan={5}>No players online</td></tr>
          ) : rows.map(p => (
            <tr key={p.id}>
              <td style={td}>{p.name}</td>
              <td style={td} title={p.id}>{p.id.slice(0, 10)}…</td>
              <td style={td}>{p.level ?? "-"}</td>
              <td style={td}>{p.ping ?? "-"}</td>
              <td style={td}>{p.duration}</td>
            </tr>
          ))}
        </tbody>
        </table>
      </div>

      <div style={card}>
        <h3 style={{ marginTop: 0 }}>Logs</h3>
        <div ref={logRef} style={{
          background: "#0a0f14", padding: 12, height: 220, overflow: "auto",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          borderRadius: 8, border: "1px solid #1b2633"
        }}>
          {log.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      </div>
    </div>
  );
}
