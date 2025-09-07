#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use anyhow::Result;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use chrono::{DateTime, Utc};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use tauri::{Manager, State};
use reqwest::header::{CONTENT_LENGTH, CONNECTION, ACCEPT, USER_AGENT, CONTENT_TYPE};
use std::time::Duration;
use std::sync::atomic::{AtomicBool, Ordering};
use urlencoding::encode; // Cargo.toml: urlencoding = "2"


static SAVING: AtomicBool = AtomicBool::new(false);


#[derive(Clone, Debug, Serialize, Deserialize, Default)]
struct ApiConfig {
    base_url: String,
    // Palworld REST uses HTTP Basic Auth, username "admin", password = AdminPassword
    password: Option<String>,
}

#[derive(Default)]
struct AppState {
    config: Mutex<ApiConfig>,
    tracker: Mutex<PlayerTracker>,
}

#[derive(Default)]
struct PlayerTracker {
    // playerId -> first seen
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

// ===== Frontend DTOs =====
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

fn v1_base(base: &str) -> String {
    let b = base.trim_end_matches('/');
    if b.ends_with("/v1/api") { b.to_string() } else { format!("{}/v1/api", b) }
}

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

/// Try /announce and /broadcast with JSON → text → GET; return true on first success.
async fn announce_multi(client: &reqwest::Client, base: &str, pass: &str, msg: &str) -> bool {
    let v1 = v1_base(base);

    for path in ["announce", "broadcast"] {
        if post_json(client, &v1, pass, path, msg).await { return true; }
        if post_text(client, &v1, pass, path, msg).await { return true; }
        if get_query (client, &v1, pass, path, msg).await { return true; }
    }
    false
}


// ===== Commands =====
#[tauri::command]
fn set_config(state: State<'_, AppState>, mut base_url: String, password: Option<String>) -> Result<(), String> {
    base_url = base_url.trim().to_string();
    if base_url.is_empty() {
        return Err("base_url is empty".into());
    }
    // Allow user to type just host:port or http(s)://host:port
    if !base_url.starts_with("http://") && !base_url.starts_with("https://") {
        base_url = format!("http://{}", base_url);
    }
    let mut cfg = state.config.lock();
    cfg.base_url = base_url;
    cfg.password = password;
    Ok(())
}

#[tauri::command]
fn get_config(state: State<'_, AppState>) -> ApiConfig {
    state.config.lock().clone()
}

#[tokio::main]
async fn main() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            set_config,
            get_config,
            get_server_info,
            get_players,
            announce_message,
            force_save,
            shutdown_server,
            backup_now,
            start_auto_restart,
            stop_auto_restart,
            player_durations
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

// ===== HTTP helpers =====
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
    // 1) if user already put /v1/api in base, just use it
    v.push(format!("{}/{}", b, p));
    // 2) otherwise, try base + /v1/api + /p
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
            Ok(resp) => {
                last_err = Some(anyhow::anyhow!("GET {} -> {}", url, resp.status()));
            }
            Err(e) => last_err = Some(e.into()),
        }
    }
    Err(last_err.unwrap_or_else(|| anyhow::anyhow!("no URL worked")))
}

async fn api_post_value(cfg: &ApiConfig, path: &str, body: Option<serde_json::Value>) -> Result<serde_json::Value> {
    if cfg.base_url.trim().is_empty() {
        anyhow::bail!("config.base_url not set");
    }
    let client = reqwest::Client::new();
    let auth = build_basic_header(&cfg.password);
    let urls = candidate_urls(&cfg.base_url, path);

    let mut last_err: Option<anyhow::Error> = None;
    for url in urls {
        let mut req = client.post(&url);
        if let Some(h) = &auth { req = req.header(reqwest::header::AUTHORIZATION, h); }
        match &body {
            Some(b) => { req = req.json(b); }
            None => { req = req.header(reqwest::header::CONTENT_LENGTH, "0"); } // <-- important for 411 servers
        }

        match req.send().await {
            Ok(resp) if resp.status().is_success() => {
                return Ok(resp.json::<serde_json::Value>().await.unwrap_or(serde_json::Value::Null));
            }
            Ok(resp) => last_err = Some(anyhow::anyhow!("POST {} -> {}", url, resp.status())),
            Err(e) => last_err = Some(e.into()),
        }
    }
    Err(last_err.unwrap_or_else(|| anyhow::anyhow!("no URL worked")))
}


// ===== JSON coercers so we tolerate different REST shapes =====
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
            if let Some(u) = n.as_u64() { return Some(u as usize); }
            if let Some(f) = n.as_f64() { return Some(f as usize); }
            if let Some(s) = n.as_str().and_then(|t| t.parse::<usize>().ok()) { return Some(s); }
        }
    }
    None
}
fn u64_alt(v: &Value, keys: &[&str]) -> Option<u64> {
    for k in keys {
        if let Some(n) = v.get(*k) {
            if let Some(u) = n.as_u64() { return Some(u); }
            if let Some(f) = n.as_f64() { return Some(f as u64); }
            if let Some(s) = n.as_str().and_then(|t| t.parse::<u64>().ok()) { return Some(s); }
        }
    }
    None
}

fn coerce_server_info(v: &Value) -> ServerInfo {
    let root = v.get("data").unwrap_or(v);
    let name = s_alt(root, &["servername", "name", "serverName"]).unwrap_or_else(|| "Unknown".into());
    let map = s_alt(root, &["map", "world", "World"]);
    let maxp = u_alt(root, &["max_players", "maxPlayers", "MaxPlayers"]);
    let up = u64_alt(root, &["uptime", "uptimeSeconds", "Uptime"]);
    let mut players_online = u_alt(root, &["players_online", "playersOnline", "currentPlayers"]).unwrap_or(0);
    if players_online == 0 {
        if let Some(arr) = root.get("players").and_then(|x| x.as_array()) {
            players_online = arr.len();
        } else if let Some(obj) = root.get("players").and_then(|x| x.as_object()) {
            players_online = obj.len();
        }
    }
    ServerInfo { name, map, players_online, max_players: maxp, uptime_seconds: up }
}
fn player_from_obj(v: &Value) -> Option<Player> {
    let id = s_alt(v, &["playerId","id","steamId","userId","uid"])?;
    let name = s_alt(v, &["name","playerName","characterName","displayName"]).unwrap_or_else(|| "Unknown".into());
    let level = u_alt(v, &["level","lvl"]).map(|x| x as u32);
    let ping  = u_alt(v, &["ping","latency"]).map(|x| x as u32);
    Some(Player { id, name, level, ping, connected_seconds: None })
}
fn coerce_players(v: &Value) -> Vec<Player> {
    let root = v.get("data").unwrap_or(v);
    let collect = |vv: &Value| -> Vec<Player> {
        if let Some(arr) = vv.as_array()     { arr.iter().filter_map(player_from_obj).collect() }
        else if let Some(obj) = vv.as_object() { obj.values().filter_map(player_from_obj).collect() }
        else { vec![] }
    };
    if let Some(pl) = root.get("players") { collect(pl) } else { collect(root) }
}

// commands
#[tauri::command]
async fn get_server_info(state: State<'_, AppState>) -> Result<ServerInfo, String> {
    let cfg = state.config.lock().clone();
    api_get_value(&cfg, "info").await
        .map(|v| coerce_server_info(&v))
        .map_err(|e| e.to_string())
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
    Ok(players)
}

#[tauri::command]
fn player_durations(state: State<'_, AppState>) -> HashMap<String, i64> {
    state.tracker.lock().seen.iter()
        .map(|(k, t)| (k.clone(), (Utc::now() - *t).num_seconds()))
        .collect()
}

#[tauri::command]
async fn announce_message(state: State<'_, AppState>, message: String) -> Result<(), String> {
    let cfg = state.config.lock().clone();
    let body = serde_json::json!({ "message": message });
    api_post_value(&cfg, "announce", Some(body)).await.map(|_| ()).map_err(|e| e.to_string())
}

fn build_v1_base(base: &str) -> String {
    let b = base.trim_end_matches('/');
    if b.ends_with("/v1/api") { b.to_string() } else { format!("{}/v1/api", b) }
}

fn build_save_url(base: &str) -> String {
    format!("{}/save", build_v1_base(base))
}

/// Try to announce a message via several common REST variants
async fn announce_any(client: &reqwest::Client, base: &str, pass: &str, msg: &str) {
    let v1 = build_v1_base(base);
    let candidates = [
        // preferred endpoints
        format!("{}/announce", v1),
        format!("{}/broadcast", v1),
        // some servers accept query-string form
        format!("{}/announce?message={}", v1, encode(msg)),
        format!("{}/broadcast?message={}", v1, encode(msg)),
    ];

    for url in candidates {
        // 1) JSON body {"message": "..."}
        let r = client
            .post(&url)
            .basic_auth("admin", Some(pass))
            .header(CONTENT_TYPE, "application/json")
            .body(format!(r#"{{"message":"{}"}}"#, msg))
            .send()
            .await;
        if r.as_ref().map(|x| x.status().is_success()).unwrap_or(false) { return; }

        // 2) plain text body
        let r = client
            .post(&url)
            .basic_auth("admin", Some(pass))
            .header(CONTENT_TYPE, "text/plain; charset=utf-8")
            .body(msg.to_string())
            .send()
            .await;
        if r.as_ref().map(|x| x.status().is_success()).unwrap_or(false) { return; }

        // 3) GET with query already tried above; keep going to next candidate
    }
}

#[tauri::command]
async fn force_save(state: tauri::State<'_, AppState>) -> Result<String, String> {
    let cfg  = state.config.lock().clone();
    let pass = cfg.password.clone().unwrap_or_default();
    let base = cfg.base_url.clone();

    // Normalize save URL once
    let save_url_for_log = format!("{}/save", v1_base(&base));
    let return_url = save_url_for_log.clone(); // keep a copy for immediate return

    // prevent concurrent saves
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
            Err(_) => { SAVING.store(false, Ordering::SeqCst); return; }
        };

        // Announce immediately
        let _ = announce_multi(&client, &base, &pass, "Saving world…").await;

        // POST /v1/api/save and wait as long as the server needs
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

    // try each shape
    for b in bodies {
        if api_post_value(&cfg, "shutdown", Some(b)).await.is_ok() {
            return Ok(());
        }
    }
    // last resort: some servers accept POST with no body
    api_post_value(&cfg, "shutdown", None)
        .await.map(|_| ()).map_err(|e| e.to_string())
}


// (Keep your real backup/auto-restart logic here – this is a stub just to keep UI working)
#[tauri::command]
async fn backup_now(
    _state: State<'_, AppState>,
    save_dir: Option<String>,
    saveDir: Option<String>,
) -> Result<String, String> {
    let dir = save_dir.or(saveDir).ok_or("missing save_dir")?;
    // TODO: implement real zip; for now just echo so UI stops erroring
    Ok(format!("{}\\backup.zip", dir.trim_end_matches('\\')))
}


static AUTORESTART: Mutex<bool> = Mutex::new(false);

#[tauri::command]
async fn start_auto_restart(state: State<'_, AppState>, minutes: u64) -> Result<(), String> {
    *AUTORESTART.lock() = true;
    let cfg = state.config.lock().clone();
    tauri::async_runtime::spawn(async move {
        while *AUTORESTART.lock() {
            tokio::time::sleep(std::time::Duration::from_secs(minutes * 60)).await;
            if !*AUTORESTART.lock() { break; }
            let _ = api_post_value(&cfg, "save", None).await;
            let _ = api_post_value(&cfg, "shutdown",
                Some(serde_json::json!({ "seconds": 60, "message": "Auto restart" }))).await;
        }
    });
    Ok(())
}

#[tauri::command]
async fn stop_auto_restart(_state: State<'_, AppState>) -> Result<(), String> {
    *AUTORESTART.lock() = false;
    Ok(())
}
