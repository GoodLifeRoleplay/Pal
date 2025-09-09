#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use anyhow::Result;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use chrono::{DateTime, Local, NaiveTime, TimeZone, Utc};
use parking_lot::Mutex;
use reqwest::header::{ACCEPT, CONNECTION, CONTENT_LENGTH, CONTENT_TYPE, USER_AGENT};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    process::Command,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::{Manager, State};
use urlencoding::encode;

static SAVING: AtomicBool = AtomicBool::new(false);
static RESTART_GEN: AtomicUsize = AtomicUsize::new(0);

#[derive(Clone, Debug, Serialize, Deserialize)]
struct ApiConfig {
    base_url: String,
    password: Option<String>,
    // new:
    start_cmd: Option<String>,        // e.g. C:\palworldserver\start-palworld.bat
    backup_dir: Option<String>,       // optional for future backups
    restart_times: Vec<String>,       // ["03:00","09:00","15:00","21:00"] local time
    discord_webhook: Option<String>,  // Discord webhook URL for important events
}
impl Default for ApiConfig {
    fn default() -> Self {
        Self {
            base_url: String::new(),
            password: None,
            start_cmd: None,
            backup_dir: None,
            restart_times: vec![], // empty => no scheduled restarts
            discord_webhook: None,
        }
    }
}

#[derive(Default)]
struct PlayerTracker {
    seen: HashMap<String, DateTime<Utc>>,
}
impl PlayerTracker {
    fn update_with(&mut self, players: &[Player]) {
        let now = Utc::now();
        for p in players {
            self.seen.entry(p.id.clone()).or_insert(now);
        }
    }
    fn connected_for(&self, id: &str) -> Option<i64> {
        self.seen.get(id).map(|t| (Utc::now() - *t).num_seconds())
    }
}

#[derive(Default)]
struct AppState {
    config: Mutex<ApiConfig>,
    tracker: Mutex<PlayerTracker>,
    // scheduler generation: bump to cancel previous task
    sched: Arc<AtomicUsize>,
    last_players: Mutex<HashSet<String>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct ServerInfo {
    name: String,
    map: Option<String>,
    players_online: usize,
    max_players: Option<usize>,
    uptime_seconds: Option<u64>,
}
#[derive(Debug, Serialize, Deserialize, Clone)]
struct Player {
    id: String,
    name: String,
    level: Option<u32>,
    ping: Option<u32>,
    connected_seconds: Option<i64>,
}

/* ----------------------- helpers ----------------------- */

fn v1_base(base: &str) -> String {
    let b = base.trim_end_matches('/');
    if b.ends_with("/v1/api") {
        b.to_string()
    } else {
        format!("{}/v1/api", b)
    }
}

fn build_basic_header(password: &Option<String>) -> Option<String> {
    password.as_ref().map(|pwd| {
        let creds = format!("admin:{}", pwd);
        format!("Basic {}", B64.encode(creds.as_bytes()))
    })
}

fn candidate_urls(base: &str, path: &str) -> Vec<String> {
    let p = path.trim_start_matches('/');
    let b = base.trim_end_matches('/');
    let mut v = Vec::new();
    v.push(format!("{}/{}", b, p)); // if base already has /v1/api
    if !b.ends_with("/v1/api") {
        v.push(format!("{}/v1/api/{}", b, p));
    }
    v
}

async fn api_get_value(cfg: &ApiConfig, path: &str) -> Result<Value> {
    if cfg.base_url.trim().is_empty() {
        anyhow::bail!("config.base_url not set");
    }
    let client = reqwest::Client::new();
    let auth = build_basic_header(&cfg.password);
    let urls = candidate_urls(&cfg.base_url, path);

    let mut last_err: Option<anyhow::Error> = None;
    for url in urls {
        let mut req = client.get(&url);
        if let Some(h) = &auth {
            req = req.header("Authorization", h);
        }
        match req.send().await {
            Ok(resp) if resp.status().is_success() => {
                return Ok(resp.json::<Value>().await?);
            }
            Ok(resp) => last_err = Some(anyhow::anyhow!("GET {} -> {}", url, resp.status())),
            Err(e) => last_err = Some(e.into()),
        }
    }
    Err(last_err.unwrap_or_else(|| anyhow::anyhow!("no URL worked")))
}

async fn api_post_value(
    cfg: &ApiConfig,
    path: &str,
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value> {
    if cfg.base_url.trim().is_empty() {
        anyhow::bail!("config.base_url not set");
    }
    let client = reqwest::Client::new();
    let auth = build_basic_header(&cfg.password);
    let urls = candidate_urls(&cfg.base_url, path);

    let mut last_err: Option<anyhow::Error> = None;
    for url in urls {
        let mut req = client.post(&url);
        if let Some(h) = &auth {
            req = req.header(reqwest::header::AUTHORIZATION, h);
        }
        match &body {
            Some(b) => {
                req = req.json(b);
            }
            None => {
                // many servers require CL:0 for /save
                req = req.header(reqwest::header::CONTENT_LENGTH, "0");
            }
        }
        match req.send().await {
            Ok(resp) if resp.status().is_success() => {
                return Ok(resp
                    .json::<serde_json::Value>()
                    .await
                    .unwrap_or(serde_json::Value::Null));
            }
            Ok(resp) => last_err = Some(anyhow::anyhow!("POST {} -> {}", url, resp.status())),
            Err(e) => last_err = Some(e.into()),
        }
    }
    Err(last_err.unwrap_or_else(|| anyhow::anyhow!("no URL worked")))
}

fn s_alt(v: &Value, keys: &[&str]) -> Option<String> {
    for k in keys {
        if let Some(s) = v.get(*k).and_then(|x| x.as_str()) {
            return Some(s.to_string());
        }
    }
    None
}
fn u_alt(v: &Value, keys: &[&str]) -> Option<usize> {
    for k in keys {
        if let Some(n) = v.get(*k) {
            if let Some(u) = n.as_u64() {
                return Some(u as usize);
            }
            if let Some(f) = n.as_f64() {
                return Some(f as usize);
            }
            if let Some(s) = n.as_str().and_then(|t| t.parse::<usize>().ok()) {
                return Some(s);
            }
        }
    }
    None
}
fn u64_alt(v: &Value, keys: &[&str]) -> Option<u64> {
    for k in keys {
        if let Some(n) = v.get(*k) {
            if let Some(u) = n.as_u64() {
                return Some(u);
            }
            if let Some(f) = n.as_f64() {
                return Some(f as u64);
            }
            if let Some(s) = n.as_str().and_then(|t| t.parse::<u64>().ok()) {
                return Some(s);
            }
        }
    }
    None
}

fn coerce_server_info(v: &Value) -> ServerInfo {
    let root = v.get("data").unwrap_or(v);
    let name = s_alt(root, &["servername", "name", "serverName"])
        .unwrap_or_else(|| "Unknown".into());
    let map = s_alt(root, &["map", "world", "World"]);
    let maxp = u_alt(root, &["max_players", "maxPlayers", "MaxPlayers"]);
    let up = u64_alt(root, &["uptime", "uptimeSeconds", "Uptime"]);
    let mut players_online =
        u_alt(root, &["players_online", "playersOnline", "currentPlayers"]).unwrap_or(0);
    if players_online == 0 {
        if let Some(arr) = root.get("players").and_then(|x| x.as_array()) {
            players_online = arr.len();
        } else if let Some(obj) = root.get("players").and_then(|x| x.as_object()) {
            players_online = obj.len();
        }
    }
    ServerInfo {
        name,
        map,
        players_online,
        max_players: maxp,
        uptime_seconds: up,
    }
}
fn player_from_obj(v: &Value) -> Option<Player> {
    let id = s_alt(v, &["steamId", "playerId", "id", "userId", "uid"])?;
    let name = s_alt(v, &["name", "playerName", "characterName", "displayName"])
        .unwrap_or_else(|| "Unknown".into());
    let level = u_alt(v, &["level", "lvl"]).map(|x| x as u32);
    let ping = u_alt(v, &["ping", "latency"]).map(|x| x as u32);
    Some(Player {
        id,
        name,
        level,
        ping,
        connected_seconds: None,
    })
}
fn coerce_players(v: &Value) -> Vec<Player> {
    let root = v.get("data").unwrap_or(v);
    let collect = |vv: &Value| -> Vec<Player> {
        if let Some(arr) = vv.as_array() {
            arr.iter().filter_map(player_from_obj).collect()
        } else if let Some(obj) = vv.as_object() {
            obj.values().filter_map(player_from_obj).collect()
        } else {
            vec![]
        }
    };
    if let Some(pl) = root.get("players") {
        collect(pl)
    } else {
        collect(root)
    }
}

/* --------------------- announce helpers --------------------- */

async fn post_json(client: &reqwest::Client, v1: &str, pass: &str, path: &str, msg: &str) -> bool {
    client
        .post(&format!("{}/{}", v1, path))
        .basic_auth("admin", Some(pass))
        .header(CONTENT_TYPE, "application/json")
        .body(format!(r#"{{"message":"{}"}}"#, msg))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}
async fn post_text(client: &reqwest::Client, v1: &str, pass: &str, path: &str, msg: &str) -> bool {
    client
        .post(&format!("{}/{}", v1, path))
        .basic_auth("admin", Some(pass))
        .header(CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(msg.to_string())
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}
async fn get_query(client: &reqwest::Client, v1: &str, pass: &str, path: &str, msg: &str) -> bool {
    client
        .get(&format!("{}/{path}?message={}", v1, encode(msg)))
        .basic_auth("admin", Some(pass))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}
async fn announce_multi(client: &reqwest::Client, base: &str, pass: &str, msg: &str) -> bool {
    let v1 = v1_base(base);
    for path in ["announce", "broadcast"] {
        if post_json(client, &v1, pass, path, msg).await {
            return true;
        }
        if post_text(client, &v1, pass, path, msg).await {
            return true;
        }
        if get_query(client, &v1, pass, path, msg).await {
            return true;
        }
    }
    false
}

/* ----------------------- Tauri commands ----------------------- */

#[tauri::command]
fn get_config(state: State<'_, AppState>) -> ApiConfig {
    state.config.lock().clone()
}

#[tauri::command]
fn set_config(
    state: State<'_, AppState>,
    mut base_url: String,
    password: Option<String>,
    restart_times: Option<Vec<String>>,
    start_cmd: Option<String>,
    backup_dir: Option<String>,
    discord_webhook: Option<String>,
) -> Result<(), String> {
    // normalize URL
    base_url = base_url.trim().to_string();
    if base_url.is_empty() {
        return Err("base_url is empty".into());
    }
    if !base_url.starts_with("http://") && !base_url.starts_with("https://") {
        base_url = format!("http://{}", base_url);
    }

    // update config under lock, then take a snapshot and drop the lock
    let snapshot: ApiConfig = {
        let mut cfg = state.config.lock();
        cfg.base_url = base_url;
        cfg.password = password;
        if let Some(t) = restart_times { cfg.restart_times = t; }
        cfg.start_cmd = start_cmd;
        cfg.backup_dir = backup_dir;
        cfg.discord_webhook = discord_webhook;
        cfg.clone()
    };

    // start/restart scheduler without borrowing/moving `state`
    spawn_scheduler(state.sched.clone(), &snapshot);

    Ok(())
}


#[tauri::command]
async fn get_server_info(state: State<'_, AppState>) -> Result<ServerInfo, String> {
    let cfg = state.config.lock().clone();
    let v = api_get_value(&cfg, "info").await.map_err(|e| e.to_string())?;
    let mut info = coerce_server_info(&v);
    if info.uptime_seconds.is_none() {
        if let Ok(mv) = api_get_value(&cfg, "metrics").await {
            if let Some(up) = u64_alt(&mv, &["uptime", "uptimeSeconds", "Uptime"]) {
                info.uptime_seconds = Some(up);
            }
        }
    }
    Ok(info)
}

#[tauri::command]
async fn get_players(state: State<'_, AppState>) -> Result<Vec<Player>, String> {
    let cfg = state.config.lock().clone();
    let v = api_get_value(&cfg, "players").await.map_err(|e| e.to_string())?;
    let mut players = coerce_players(&v);
    {
        let mut tr = state.tracker.lock();
        tr.update_with(&players);
        for p in players.iter_mut() {
            p.connected_seconds = tr.connected_for(&p.id);
        }
    }
    // join/leave detection + optional Discord webhook (avoid holding locks across await)
    let (joined, left, hook_opt) = {
        let current: HashSet<String> = players.iter().map(|p| p.id.clone()).collect();
        let mut last = state.last_players.lock();
        let joined: Vec<String> = current.difference(&*last).cloned().collect();
        let left: Vec<String> = last.difference(&current).cloned().collect();
        *last = current;
        (joined, left, state.config.lock().discord_webhook.clone())
    };
    if let Some(hook) = hook_opt {
        let client = reqwest::Client::new();
        for id in joined {
            let _ = client
                .post(&hook)
                .json(&serde_json::json!({"content": format!("Player joined: {}", id)}))
                .send()
                .await;
        }
        for id in left {
            let _ = client
                .post(&hook)
                .json(&serde_json::json!({"content": format!("Player left: {}", id)}))
                .send()
                .await;
        }
    }
    Ok(players)
}

#[tauri::command]
fn player_durations(state: State<'_, AppState>) -> HashMap<String, i64> {
    state
        .tracker
        .lock()
        .seen
        .iter()
        .map(|(k, t)| (k.clone(), (Utc::now() - *t).num_seconds()))
        .collect()
}

#[tauri::command]
async fn announce_message(state: State<'_, AppState>, message: String) -> Result<(), String> {
    let cfg = state.config.lock().clone();
    let body = serde_json::json!({ "message": message });
    api_post_value(&cfg, "announce", Some(body))
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn force_save(state: State<'_, AppState>) -> Result<String, String> {
    let cfg = state.config.lock().clone();
    let base = cfg.base_url.clone();
    let pass = cfg.password.clone().unwrap_or_default();

    let save_url_for_log = format!("{}/save", v1_base(&base));
    let return_url = save_url_for_log.clone();

    if SAVING.swap(true, Ordering::SeqCst) {
        return Ok("save already in progress".into());
    }

    tauri::async_runtime::spawn(async move {
        let client = match reqwest::Client::builder()
            .http1_only()
            .pool_idle_timeout(Duration::from_secs(0))
            .build()
        {
            Ok(c) => c,
            Err(_) => {
                SAVING.store(false, Ordering::SeqCst);
                return;
            }
        };

        let _ = announce_multi(&client, &base, &pass, "Saving world…").await;

        let status_opt = client
            .post(&save_url_for_log)
            .basic_auth("admin", Some(&pass))
            .header(CONTENT_LENGTH, "0")
            .header(CONNECTION, "close")
            .header(ACCEPT, "*/*")
            .header(USER_AGENT, "curl/8.13.0")
            .send()
            .await
            .ok()
            .map(|r| r.status());

        match status_opt {
            Some(s) if s.is_success() => {
                let _ = announce_multi(&client, &base, &pass, "Game saved").await;
            }
            Some(s) => {
                let _ = announce_multi(&client, &base, &pass, &format!("Save failed: {s}")).await;
            }
            None => {
                let _ = announce_multi(&client, &base, &pass, "Save error: request failed").await;
            }
        }

        SAVING.store(false, Ordering::SeqCst);
    });

    Ok(format!("dispatched POST {}", return_url))
}

#[tauri::command]
async fn shutdown_server(
    state: State<'_, AppState>,
    seconds: Option<u64>,
    msg: Option<String>,
) -> Result<(), String> {
    let cfg = state.config.lock().clone();
    let s = seconds.unwrap_or(60);
    let m = msg.unwrap_or_else(|| "Server restarting...".into());

    let bodies = [
        serde_json::json!({ "seconds": s, "message": &m }),
        serde_json::json!({ "time": s,    "message": &m }),
        serde_json::json!({ "duration": s,"message": &m }),
        serde_json::json!({ "Seconds": s, "Message": &m }),
    ];
    for b in bodies {
        if api_post_value(&cfg, "shutdown", Some(b)).await.is_ok() {
            return Ok(());
        }
    }
    api_post_value(&cfg, "shutdown", None)
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn restart_now(state: State<'_, AppState>, seconds: Option<u64>) -> Result<(), String> {
    let cfg = state.config.lock().clone();
    let lead = seconds.unwrap_or(60);
    let base = cfg.base_url.clone();
    let pass = cfg.password.clone().unwrap_or_default();
    let start_cmd = cfg.start_cmd.clone();

    // single client used for all steps
    let client = match reqwest::Client::builder()
        .http1_only()
        .pool_idle_timeout(Duration::from_secs(0))
        .build()
    {
        Ok(c) => c,
        Err(e) => return Err(e.to_string()),
    };

    // pre-announce with lead time
    let _ = announce_multi(&client, &base, &pass, &format!("Auto-restart in {} seconds.", lead)).await;
    if let Some(hook) = cfg.discord_webhook.clone() { let _ = reqwest::Client::new().post(&hook).json(&serde_json::json!({"content": format!("Manual restart scheduled in {} seconds.", lead)})).send().await; }
    tokio::time::sleep(Duration::from_secs(lead)).await;

    // save (best-effort)
    let _ = client
        .post(format!("{}/save", v1_base(&base)))
        .basic_auth("admin", Some(&pass))
        .header(CONTENT_LENGTH, "0")
        .header(CONNECTION, "close")
        .header(ACCEPT, "*/*")
        .header(USER_AGENT, "curl/8.13.0")
        .send()
        .await;

    let _ = announce_multi(&client, &base, &pass, "Restarting server.").await;
    if let Some(hook) = cfg.discord_webhook.clone() { let _ = reqwest::Client::new().post(&hook).json(&serde_json::json!({"content": "Manual restart executing."})).send().await; }

    // try various shutdown shapes
    let bodies = [
        serde_json::json!({ "seconds": 5, "message": "Auto restart" }),
        serde_json::json!({ "time": 5, "message": "Auto restart" }),
        serde_json::json!({ "duration": 5, "message": "Auto restart" }),
    ];
    let mut ok = false;
    for b in bodies {
        if client
            .post(format!("{}/shutdown", v1_base(&base)))
            .basic_auth("admin", Some(&pass))
            .json(&b)
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false)
        {
            ok = true;
            break;
        }
    }
    if !ok {
        // last attempt without body
        let _ = client
            .post(format!("{}/shutdown", v1_base(&base)))
            .basic_auth("admin", Some(&pass))
            .header(CONTENT_LENGTH, "0")
            .send()
            .await;
    }

    // allow process to exit
    tokio::time::sleep(Duration::from_secs(12)).await;

    if let Some(c) = start_cmd {
        if c.trim().to_lowercase().ends_with(".bat") {
            let _ = Command::new("cmd").args(["/C", &c]).spawn();
        } else {
            let _ = Command::new(&c).spawn();
        }
    }

    Ok(())
}
/* ------------ optional stub for manual backup button ------------ */

#[tauri::command]
async fn backup_now(
    _state: State<'_, AppState>,
    save_dir: Option<String>,
    saveDir: Option<String>,
) -> Result<String, String> {
    let dir = save_dir
        .or(saveDir)
        .ok_or_else(|| "missing save_dir".to_string())?;
    Ok(format!("{}\\backup.zip", dir.trim_end_matches('\\')))
}

#[tauri::command]
fn cancel_restart() {
    RESTART_GEN.fetch_add(1, Ordering::SeqCst);
}

#[tauri::command]
async fn unban_player(state: State<'_, AppState>, player_id: String) -> Result<(), String> {
    let cfg = state.config.lock().clone();
    // Try multiple endpoints and body shapes for compatibility
    let paths = ["unban", "pardon"];
    let bodies = [
        serde_json::json!({ "steamId": player_id }),
        serde_json::json!({ "playerId": player_id }),
        serde_json::json!({ "id": player_id }),
    ];
    for p in &paths {
        for b in &bodies {
            if api_post_value(&cfg, p, Some(b.clone())).await.is_ok() {
                return Ok(());
            }
        }
        if api_post_value(&cfg, p, None).await.is_ok() {
            return Ok(());
        }
    }
    Err("unban failed".into())
}
#[tauri::command]
async fn kick_player(state: State<'_, AppState>, player_id: String) -> Result<(), String> {
    let cfg = state.config.lock().clone();
    let bodies = [
        serde_json::json!({ "steamId": player_id }),
        serde_json::json!({ "playerId": player_id }),
        serde_json::json!({ "id": player_id }),
    ];
    for b in bodies {
        if api_post_value(&cfg, "kick", Some(b)).await.is_ok() {
            return Ok(());
        }
    }
    api_post_value(&cfg, "kick", None)
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn ban_player(state: State<'_, AppState>, player_id: String) -> Result<(), String> {
    let cfg = state.config.lock().clone();
    let bodies = [
        serde_json::json!({ "steamId": player_id }),
        serde_json::json!({ "playerId": player_id }),
        serde_json::json!({ "id": player_id }),
    ];
    for b in bodies {
        if api_post_value(&cfg, "ban", Some(b)).await.is_ok() {
            return Ok(());
        }
    }
    api_post_value(&cfg, "ban", None)
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
}
/* ------------------- scheduler (specific times) ------------------- */

fn parse_times_hhmm(v: &[String]) -> Vec<NaiveTime> {
    v.iter()
        .filter_map(|s| NaiveTime::parse_from_str(s.trim(), "%H:%M").ok())
        .collect()
}

fn next_fire_from(now: DateTime<Local>, times: &[NaiveTime]) -> Option<DateTime<Local>> {
    if times.is_empty() {
        return None;
    }
    let today = now.date_naive();
    let mut candidates: Vec<_> = times
        .iter()
        .filter_map(|t| Local.from_local_datetime(&today.and_time(*t)).single())
        .collect();
    candidates.sort_unstable();
    for dt in &candidates {
        if *dt > now {
            return Some(*dt);
        }
    }
    // tomorrow at the first time
    let tomorrow = today.succ_opt()?;
    let mut next_day: Vec<_> = times
        .iter()
        .filter_map(|t| Local.from_local_datetime(&tomorrow.and_time(*t)).single())
        .collect();
    next_day.sort_unstable();
    next_day.first().copied()
}

fn spawn_scheduler(sched: Arc<AtomicUsize>, cfg: &ApiConfig) {
    let times = parse_times_hhmm(&cfg.restart_times);
    let base = cfg.base_url.clone();
    let pass = cfg.password.clone().unwrap_or_default();
    let cmd  = cfg.start_cmd.clone();

    // bump generation; my_id is what this task will check
    let my_id = sched.fetch_add(1, Ordering::SeqCst) + 1;

    if times.is_empty() {
        return;
    }

    tauri::async_runtime::spawn(async move {
        // (rest of the function unchanged)
        // make sure all references to `state.sched` are replaced with `sched`
        // build shared client
        let client = match reqwest::Client::builder()
            .http1_only()
            .pool_idle_timeout(Duration::from_secs(0))
            .build()
        {
            Ok(c) => c,
            Err(_) => return,
        };

        loop {
            // canceled/replaced?
            if sched.load(Ordering::SeqCst) != my_id {
                break;
            }

            let now = Local::now();
            let Some(next_dt) = next_fire_from(now, &times) else {
                break;
            };
            let sleep_ms = (next_dt - now).num_milliseconds().max(0) as u64;
            tokio::time::sleep(Duration::from_millis(sleep_ms)).await;

            if sched.load(Ordering::SeqCst) != my_id {
                break;
            }

            // announce + save + shutdown + start .bat
            let _ = announce_multi(&client, &base, &pass, "Auto-restart in 60 seconds.").await;

            // save (best-effort)
            let _ = client
                .post(format!("{}/save", v1_base(&base)))
                .basic_auth("admin", Some(&pass))
                .header(CONTENT_LENGTH, "0")
                .header(CONNECTION, "close")
                .header(ACCEPT, "*/*")
                .header(USER_AGENT, "curl/8.13.0")
                .send()
                .await;

            let _ = announce_multi(&client, &base, &pass, "Restarting server…").await;

            // try various shutdown shapes
            let bodies = [
                serde_json::json!({ "seconds": 5, "message": "Auto restart" }),
                serde_json::json!({ "time": 5, "message": "Auto restart" }),
                serde_json::json!({ "duration": 5, "message": "Auto restart" }),
            ];
            let mut ok = false;
            for b in bodies {
                if client
                    .post(format!("{}/shutdown", v1_base(&base)))
                    .basic_auth("admin", Some(&pass))
                    .json(&b)
                    .send()
                    .await
                    .map(|r| r.status().is_success())
                    .unwrap_or(false)
                {
                    ok = true;
                    break;
                }
            }
            if !ok {
                // last attempt without body
                let _ = client
                    .post(format!("{}/shutdown", v1_base(&base)))
                    .basic_auth("admin", Some(&pass))
                    .header(CONTENT_LENGTH, "0")
                    .send()
                    .await;
            }

            // allow process to exit
            tokio::time::sleep(Duration::from_secs(12)).await;

            if let Some(c) = &cmd {
                // Start the Windows .bat / .exe
                if c.trim().to_lowercase().ends_with(".bat") {
                    let _ = Command::new("cmd").args(["/C", c]).spawn();
                } else {
                    let _ = Command::new(c).spawn();
                }
            }
        }
    });
}

/* ------------------------- Tauri bootstrap ------------------------- */

#[tokio::main]
async fn main() {
    tauri::Builder::default()
        .manage(AppState {
            config: Mutex::new(ApiConfig::default()),
            tracker: Mutex::new(PlayerTracker::default()),
            sched: Arc::new(AtomicUsize::new(0)),
            last_players: Mutex::new(HashSet::new()),
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            set_config,
            get_server_info,
            get_players,
            player_durations,
            announce_message,
            force_save,
            shutdown_server,
            cancel_restart,
            kick_player,
            ban_player,
            unban_player,
            restart_now,
            backup_now
        ])
        .setup(|app| {
            let win = app.get_window("main").unwrap();
            #[cfg(debug_assertions)]
            win.open_devtools();
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
