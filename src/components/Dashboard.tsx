import React, { useEffect, useMemo, useState } from "react";
import {
  setConfig, getServerInfo, getPlayers, getDurations,
  sendBroadcast, forceSave, shutdown, runBackup,
  startAutoRestart, stopAutoRestart
} from "../services/api";

type Player = { id: string; name: string; level?: number; ping?: number };

export default function Dashboard() {
  const [baseUrl, setBaseUrl] = useState("http://127.0.0.1:8212/v1/api");
  const [token, setToken] = useState("");
  const [server, setServer] = useState<any>(null);
  const [players, setPlayers] = useState<Player[]>([]);
  const [durations, setDurations] = useState<Record<string, number>>({});
  const [msg, setMsg] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const [saveDir, setSaveDir] = useState("C:\\\\palworldserver\\\\Pal\\Saved\\SaveGames");
  const [startCmd, setStartCmd] = useState<string>("");
  const [intervalMin, setIntervalMin] = useState(240); // 4 hours

  useEffect(() => {
    setConfig({ base_url: baseUrl, token: token || undefined })
      .then(() => pushLog(`REST route: "${baseUrl}"`))
      .catch(e => pushLog(`Config error: ${e}`));
  }, [baseUrl, token]);

  useEffect(() => {
    const t = setInterval(() => refresh(), 5000);
    refresh();
    return () => clearInterval(t);
  }, []);

  async function refresh() {
    try {
      const s = await getServerInfo();
      setServer(s);
    } catch (e:any) { pushLog(`Server info failed: ${e}`); }
    try {
      const p = await getPlayers();
      setPlayers(p);
      const d = await getDurations();
      setDurations(d);
      pushLog("Refreshed server info/players");
    } catch (e:any) { pushLog(`Players failed: ${e}`); }
  }

  function pushLog(line: string) {
    const time = new Date().toLocaleTimeString();
    setLog(l => [`[${time}] ${line}`, ...l].slice(0, 500));
  }

  async function onBroadcast() {
    try { await sendBroadcast(msg); pushLog("Broadcast sent"); setMsg(""); }
    catch (e:any) { pushLog(`Broadcast failed: ${e?.toString?.() || e}`); }
  }

  async function onSave() {
    try { await forceSave(); pushLog("Save triggered"); }
    catch (e:any) { pushLog(`Save failed: ${e}`); }
  }

  async function onShutdown() {
    const delay = 60;
    try { await shutdown(delay); pushLog(`Shutdown in ${delay}s`); }
    catch (e:any) { pushLog(`Shutdown failed: ${e}`); }
  }

  async function onBackup() {
    try {
      const zipPath = await runBackup(saveDir);
      pushLog(`Backup created: ${zipPath}`);
    } catch (e:any) {
      pushLog(`Backup failed: ${e}`);
    }
  }

  async function onStartAuto() {
    try {
      await startAutoRestart({
        interval_minutes: Number(intervalMin),
        save_dir: saveDir,
        start_command: startCmd || undefined
      });
      pushLog(`Auto-restart ON (every ${intervalMin} min)`);
    } catch (e:any) { pushLog(`Auto-restart failed: ${e}`); }
  }

  async function onStopAuto() {
    try { await stopAutoRestart(); pushLog("Auto-restart OFF"); }
    catch (e:any) { pushLog(`Stop failed: ${e}`); }
  }

  function fmtSecs(s?: number) {
    if (!s && s !== 0) return "";
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return [h ? `${h}h` : "", m ? `${m}m` : "", `${sec}s`].filter(Boolean).join(" ");
  }

  const rows = useMemo(() => {
    return players.map(p => ({
      ...p,
      duration: fmtSecs(durations[p.id] ?? 0),
    }));
  }, [players, durations]);

  return (
    <div style={{ padding: 16, color: "#d7dae0", background: "#0f141a", minHeight: "100vh" }}>
      <h2 style={{ marginBottom: 12 }}>Palworld Control</h2>

      {/* Config */}
      <div style={card}>
        <h3>Server</h3>
        <div style={grid2}>
          <label>Base URL
            <input style={input} value={baseUrl} onChange={e => setBaseUrl(e.target.value)} />
          </label>
          <label>Token (optional)
            <input style={input} value={token} onChange={e => setToken(e.target.value)} />
          </label>
        </div>

        {server ? (
          <div style={{ marginTop: 8, opacity: 0.9 }}>
            <div><b>Name:</b> {server.name}</div>
            <div><b>Players:</b> {server.players_online}{server.max_players ? ` / ${server.max_players}` : ""}</div>
            {server.map && <div><b>Map:</b> {server.map}</div>}
          </div>
        ) : <div style={{ marginTop: 8 }}>Loading…</div>}
      </div>

      {/* Actions */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div style={card}>
          <h3>Broadcast</h3>
          <div style={{ display: "flex", gap: 8 }}>
            <input style={{ ...input, flex: 1 }} placeholder="message…" value={msg} onChange={e => setMsg(e.target.value)} />
            <button style={btn} onClick={onBroadcast}>Send</button>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button style={btn} onClick={onSave}>Force Save</button>
            <button style={btn} onClick={refresh}>Refresh Players</button>
            <button style={btnDanger} onClick={onShutdown}>Shutdown</button>
          </div>
        </div>

        <div style={card}>
          <h3>Auto-Restart & Backups</h3>
          <div style={grid2}>
            <label>Save Dir
              <input style={input} value={saveDir} onChange={e => setSaveDir(e.target.value)} />
            </label>
            <label>Interval (min)
              <input style={input} type="number" value={intervalMin} onChange={e => setIntervalMin(Number(e.target.value))} />
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

      {/* Players */}
      <div style={card}>
        <h3>Players</h3>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr><th style={th}>Name</th><th style={th}>ID</th><th style={th}>Lvl</th><th style={th}>Ping</th><th style={th}>Connected</th></tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td style={td} colSpan={5} >No players online</td></tr>
            ) : rows.map(p => (
              <tr key={p.id}>
                <td style={td}>{p.name}</td>
                <td style={td} title={p.id}>{p.id.slice(0, 8)}…</td>
                <td style={td}>{p.level ?? "-"}</td>
                <td style={td}>{p.ping ?? "-"}</td>
                <td style={td}>{p.duration}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Logs */}
      <div style={card}>
        <h3>Logs</h3>
        <div style={{
          background: "#0a0f14",
          padding: 12,
          height: 220,
          overflow: "auto",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          borderRadius: 8
        }}>
          {log.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      </div>
    </div>
  );
}

const card: React.CSSProperties = {
  background: "#121821",
  border: "1px solid #1f2a37",
  borderRadius: 12,
  padding: 12,
  marginBottom: 16
};
const input: React.CSSProperties = {
  width: "100%", padding: 8, borderRadius: 8, border: "1px solid #253041",
  background: "#0b1017", color: "#e5e7eb"
};
const btn: React.CSSProperties = {
  padding: "8px 12px", borderRadius: 10, border: "1px solid #314155",
  background: "#0b1118", color: "#e5e7eb", cursor: "pointer"
};
const btnDanger: React.CSSProperties = { ...btn, borderColor: "#57333a" };
const grid2: React.CSSProperties = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 };
const th: React.CSSProperties = { textAlign: "left", borderBottom: "1px solid #233042", padding: "6px 4px" };
const td: React.CSSProperties = { borderBottom: "1px solid #192432", padding: "6px 4px", fontSize: 14 };
