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
    fs::File,
    io::{self},
    path::{Path, PathBuf},
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
    backup_dir: Option<String>,       // backup source folder
    backup_dest_dir: Option<String>,  // backup destination folder
    restart_times: Vec<String>,       // ["03:00","09:00","15:00","21:00"] local time
    discord_webhook: Option<String>,  // Discord webhook URL for important events
    allow_actions: bool,              // read-only when false
}
impl Default for ApiConfig {
    fn default() -> Self {
        Self {
            base_url: String::new(),
            password: None,
            start_cmd: None,
            backup_dir: None,
            backup_dest_dir: None,
            restart_times: vec![], // empty => no scheduled restarts
            discord_webhook: None,
            allow_actions: true,
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
    last_names: Mutex<HashMap<String, String>>,
    autosave_gen: Arc<AtomicUsize>,
    backup_gen: Arc<AtomicUsize>,
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

/* ----------------------- config persistence ----------------------- */
fn config_path() -> Option<std::path::PathBuf> {
    let base = dirs::config_dir()?;
    let dir = base.join("palworld-rest-api-client");
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join("config.json"))
}
fn load_saved_config() -> Option<ApiConfig> {
    let path = config_path()?;
    let data = std::fs::read(path).ok()?;
    serde_json::from_slice::<ApiConfig>(&data).ok()
}
fn save_config(cfg: &ApiConfig) {
    if let Some(path) = config_path() {
        if let Ok(data) = serde_json::to_vec_pretty(cfg) {
            let _ = std::fs::write(path, data);
        }
    }
}

/* ----------------------- discord embed helper ----------------------- */
const COLOR_SUCCESS: u32 = 0x22C55E; // green
const COLOR_ERROR: u32 = 0xEF4444;   // red
const COLOR_INFO: u32 = 0x3B82F6;    // blue

async fn discord_embed(hook: &str, desc: &str, color: u32) {
    let _ = reqwest::Client::new()
        .post(hook)
        .json(&serde_json::json!({
            "embeds": [{ "description": desc, "color": color }]
        }))
        .send()
        .await;
}

/* ----------------------- zip helpers (backups) ----------------------- */
fn zip_directory(src: &Path, dest_zip: &Path) -> anyhow::Result<()> {
    if !src.exists() {
        anyhow::bail!("backup source not found: {}", src.display());
    }
    let file = File::create(dest_zip)?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let src_abs = src.canonicalize().unwrap_or_else(|_| src.to_path_buf());
    let backups_dir = src_abs.join("_backups");

    for entry in walkdir::WalkDir::new(&src_abs).into_iter().filter_map(Result::ok) {
        let path = entry.path();
        let name_rel = path.strip_prefix(&src_abs).unwrap_or(path);
        if name_rel.as_os_str().is_empty() { continue; }
        // skip our backups output folder
        if path.starts_with(&backups_dir) { continue; }
        if path.is_dir() {
            let name = format!("{}/", name_rel.to_string_lossy().replace('\\', "/"));
            let _ = zip.add_directory(name, options);
        } else {
            let name = name_rel.to_string_lossy().replace('\\', "/");
            if let Ok(mut f) = File::open(path) {
                let _ = zip.start_file(name, options);
                let _ = io::copy(&mut f, &mut zip);
            }
        }
    }
    zip.finish()?;
    Ok(())
}

fn prune_old_backups(dir: &Path, days: u64) -> anyhow::Result<usize> {
    let mut removed = 0usize;
    if !dir.exists() { return Ok(0); }
    let cutoff = std::time::SystemTime::now()
        .checked_sub(Duration::from_secs(days.saturating_mul(86_400)))
        .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_file() {
            let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
            let is_backup_zip = name.starts_with("backup-") && name.ends_with(".zip");
            if !is_backup_zip { continue; }
            let modified = entry
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            if modified < cutoff {
                let _ = std::fs::remove_file(&path);
                removed += 1;
            }
        }
    }
    Ok(removed)
}

/* ----------------------- background tasks ----------------------- */
fn spawn_autosave(autosave: Arc<AtomicUsize>, cfg: &ApiConfig) {
    let my_id = autosave.fetch_add(1, Ordering::SeqCst) + 1;
    let base = cfg.base_url.clone();
    let pass = cfg.password.clone().unwrap_or_default();
    let hook = cfg.discord_webhook.clone();
    if base.trim().is_empty() { return; }
    tauri::async_runtime::spawn(async move {
        let client = match reqwest::Client::builder().http1_only().pool_idle_timeout(Duration::from_secs(0)).build() {
            Ok(c) => c,
            Err(_) => return,
        };
        loop {
            // 15 minutes
            tokio::time::sleep(Duration::from_secs(15 * 60)).await;
            if autosave.load(Ordering::SeqCst) != my_id { break; }
            // Discord log start (info)
            if let Some(h) = hook.clone() { discord_embed(&h, "Auto save started.", COLOR_INFO).await; }
            // Save request
            let _ = client
                .post(format!("{}/save", v1_base(&base)))
                .basic_auth("admin", Some(&pass))
                .header(CONTENT_LENGTH, "0")
                .header(CONNECTION, "close")
                .header(ACCEPT, "*/*")
                .header(USER_AGENT, "curl/8.13.0")
                .send()
                .await;
            if let Some(h) = hook.clone() { discord_embed(&h, "Auto save completed.", COLOR_SUCCESS).await; }
        }
    });
}

fn spawn_backup(backup: Arc<AtomicUsize>, cfg: &ApiConfig) {
    let my_id = backup.fetch_add(1, Ordering::SeqCst) + 1;
    let src_opt = cfg.backup_dir.clone();
    let dest_opt = cfg.backup_dest_dir.clone();
    let hook = cfg.discord_webhook.clone();
    if src_opt.is_none() { return; }
    let src = PathBuf::from(src_opt.unwrap());
    let dest_root = if let Some(d) = dest_opt { PathBuf::from(d) } else { src.join("_backups") };
    tauri::async_runtime::spawn(async move {
        loop {
            // 30 minutes
            tokio::time::sleep(Duration::from_secs(30 * 60)).await;
            if backup.load(Ordering::SeqCst) != my_id { break; }
            // Prepare output
            let _ = std::fs::create_dir_all(&dest_root);
            let ts = chrono::Local::now().format("%Y%m%d-%H%M%S");
            let dest = dest_root.join(format!("backup-{}.zip", ts));
            // Run zip
            let result = zip_directory(&src, &dest);
            if let Some(h) = hook.clone() {
                match result {
                    Ok(()) => {
                        discord_embed(&h, &format!("Auto backup created: {}", dest.display()), COLOR_SUCCESS).await;
                        match prune_old_backups(&dest_root, 3) {
                            Ok(n) if n > 0 => discord_embed(&h, &format!("Pruned {} backup(s) older than 3 days.", n), COLOR_INFO).await,
                            Ok(_) => {}
                            Err(e) => discord_embed(&h, &format!("Prune old backups failed: {}", e), COLOR_ERROR).await,
                        }
                    }
                    Err(e) => discord_embed(&h, &format!("Auto backup failed: {}", e), COLOR_ERROR).await,
                }
            } else {
                let _ = prune_old_backups(&dest_root, 3);
            }
        }
    });
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
    // Prefer explicit userId (often "steam_7656...") over numeric playerId/hex ids
    let mut id = s_alt(v, &["userId", "user_id", "steamId", "SteamID", "steam_id", "id", "playerId", "uid"]).or_else(|| {
        v.get("steamId")
            .and_then(|x| x.as_u64().map(|n| n.to_string()))
            .or_else(|| v.get("id").and_then(|x| x.as_u64().map(|n| n.to_string())))
            .or_else(|| v.get("playerId").and_then(|x| x.as_u64().map(|n| n.to_string())))
    })?;
    // Some servers use prefixes like "steam_7656..."; normalize to the 17-digit number when present
    if let Ok(re) = regex::Regex::new(r"(?i)steam_?(\d{17})|(?<!\d)(\d{17})(?!\d)") {
        if let Some(caps) = re.captures(&id) {
            if let Some(m) = caps.get(1).or_else(|| caps.get(2)) {
                // normalize to the form steam_<17-digits>
                id = format!("steam_{}", m.as_str());
            }
        }
    }
    let name = s_alt(v, &["name", "playerName", "characterName", "displayName"])
        .unwrap_or_else(|| "Unknown".into());
    let level = u_alt(v, &["level", "lvl"]).map(|x| x as u32);
    let ping = u_alt(v, &["ping", "latency"]).map(|x| x as u32);
    // try to read connected seconds from common keys
    let connected_seconds = {
        if let Some(n) = v.get("connected_seconds").and_then(|x| x.as_i64()) { Some(n) }
        else if let Some(n) = v.get("connectedSeconds").and_then(|x| x.as_i64()) { Some(n) }
        else if let Some(n) = v.get("sessionSeconds").and_then(|x| x.as_i64()) { Some(n) }
        else if let Some(n) = v.get("playTimeSec").and_then(|x| x.as_i64()) { Some(n) }
        else if let Some(n) = v.get("playTimeSeconds").and_then(|x| x.as_i64()) { Some(n) }
        else { None }
    };
    Some(Player {
        id,
        name,
        level,
        ping,
        connected_seconds,
    })
}

async fn server_is_up(base: &str, pass: &str) -> bool {
    let client = reqwest::Client::new();
    for url in candidate_urls(base, "info") {
        let mut req = client.get(&url);
        if !pass.is_empty() {
            req = req.basic_auth("admin", Some(pass));
        }
        if let Ok(resp) = req.send().await {
            if resp.status().is_success() { return true; }
        }
    }
    false
}

async fn wait_for_server_down(base: &str, pass: &str, max_secs: u64) -> bool {
    let mut waited = 0u64;
    loop {
        if !server_is_up(base, pass).await { return true; }
        if waited >= max_secs { return false; }
        tokio::time::sleep(Duration::from_secs(1)).await;
        waited += 1;
    }
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
    backup_dest_dir: Option<String>,
    discord_webhook: Option<String>,
    allow_actions: Option<bool>,
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
        if password.is_some() { cfg.password = password; }
        if let Some(t) = restart_times { cfg.restart_times = t; }
        if start_cmd.is_some() { cfg.start_cmd = start_cmd; }
        if backup_dir.is_some() { cfg.backup_dir = backup_dir; }
        if backup_dest_dir.is_some() { cfg.backup_dest_dir = backup_dest_dir; }
        if let Some(v) = allow_actions { cfg.allow_actions = v; }
        if discord_webhook.is_some() { cfg.discord_webhook = discord_webhook; }
        cfg.clone()
    };

    // start/restart scheduler (only if actions allowed)
    if snapshot.allow_actions {
        spawn_scheduler(state.sched.clone(), &snapshot);
    } else {
        // cancel existing scheduler
        let _ = state.sched.fetch_add(1, Ordering::SeqCst);
    }
    save_config(&snapshot);
    // Discord log: config updated
    if let Some(h) = snapshot.discord_webhook.clone() {
        let base = snapshot.base_url.clone();
        let times = if snapshot.restart_times.is_empty() { "(none)".to_string() } else { snapshot.restart_times.join(", ") };
        let actions = if snapshot.allow_actions { "enabled" } else { "disabled" };
        tauri::async_runtime::spawn(async move {
            discord_embed(&h, &format!("Config updated. Base: {} | Restarts: {} | Actions: {}", base, times, actions), COLOR_INFO).await;
        });
    }
    // start autosave and backup background tasks
    if snapshot.allow_actions {
        spawn_autosave(state.autosave_gen.clone(), &snapshot);
        spawn_backup(state.backup_gen.clone(), &snapshot);
    } else {
        let _ = state.autosave_gen.fetch_add(1, Ordering::SeqCst);
        let _ = state.backup_gen.fetch_add(1, Ordering::SeqCst);
    }

    Ok(())
}

// Try several shutdown payload shapes; return true on first success.
async fn attempt_shutdown(base: &str, pass: &str, hook: Option<String>, reason: &str) -> bool {
    let client = reqwest::Client::new();
    let url = format!("{}/shutdown", v1_base(base));
    let bodies = [
        serde_json::json!({ "waittime": 1, "message": reason }),
        serde_json::json!({ "seconds": 1,  "message": reason }),
        serde_json::json!({ "time": 1,     "message": reason }),
        serde_json::json!({ "duration": 1, "message": reason }),
    ];

    // JSON bodies first
    for (i, b) in bodies.iter().enumerate() {
        let res = client
            .post(&url)
            .basic_auth("admin", Some(pass))
            .json(b)
            .send()
            .await;
        let ok = res.as_ref().map(|r| r.status().is_success()).unwrap_or(false);
        if let Some(h) = hook.clone() {
            let msg = match &res {
                Ok(r) => format!("Shutdown attempt {} -> {}", i + 1, r.status()),
                Err(e) => format!("Shutdown attempt {} error: {}", i + 1, e),
            };
            let _ = discord_embed(&h, &msg, if ok { COLOR_SUCCESS } else { COLOR_ERROR }).await;
        }
        if ok { return true; }
    }
    // Final attempt without body but with CL:0
    let res = client
        .post(&url)
        .basic_auth("admin", Some(pass))
        .header(CONTENT_LENGTH, "0")
        .send()
        .await;
    let ok = res.as_ref().map(|r| r.status().is_success()).unwrap_or(false);
    if let Some(h) = hook {
        let msg = match res {
            Ok(r) => format!("Shutdown attempt (no body) -> {}", r.status()),
            Err(e) => format!("Shutdown attempt (no body) error: {}", e),
        };
        let _ = discord_embed(&h, &msg, if ok { COLOR_SUCCESS } else { COLOR_ERROR }).await;
    }
    ok
}

// Send staged restart warnings at 60, 30, 20, 10, and 5 seconds.
// Sleeps between stages so that total wait equals `total` seconds.
async fn warn_countdown(
    client: &reqwest::Client,
    base: &str,
    pass: &str,
    total: u64,
    hook: Option<String>,
) {
    let mut checkpoints = vec![60u64, 30, 20, 10, 5];
    checkpoints.retain(|&c| c <= total && c > 0);
    checkpoints.sort_by(|a, b| b.cmp(a)); // descending

    let mut remaining = total;
    for cp in checkpoints {
        if remaining > cp {
            tokio::time::sleep(Duration::from_secs(remaining - cp)).await;
            remaining = cp;
        }
        let msg = if cp == 5 {
            "Log off now".to_string()
        } else {
            format!("Restart in {} seconds.", cp)
        };
        let _ = announce_multi(client, base, pass, &msg).await;
        if let Some(h) = hook.clone() {
            let _ = discord_embed(&h, &msg, COLOR_INFO).await;
        }
    }
    if remaining > 0 {
        tokio::time::sleep(Duration::from_secs(remaining)).await;
    }
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
            if p.connected_seconds.is_none() {
                p.connected_seconds = tr.connected_for(&p.id);
            }
        }
    }
    // join/leave detection + optional Discord webhook (use names when possible)
    let (joined, left, names_current, names_prev, hook_opt) = {
        let current_ids: HashSet<String> = players.iter().map(|p| p.id.clone()).collect();
        let current_names: HashMap<String, String> = players
            .iter()
            .map(|p| (p.id.clone(), p.name.clone()))
            .collect();
        let mut last = state.last_players.lock();
        let mut lastn = state.last_names.lock();
        let prev_names = lastn.clone();
        let joined: Vec<String> = current_ids.difference(&*last).cloned().collect();
        let left: Vec<String> = last.difference(&current_ids).cloned().collect();
        *last = current_ids.clone();
        *lastn = current_names.clone();
        (joined, left, current_names, prev_names, state.config.lock().discord_webhook.clone())
    };
    if let Some(hook) = hook_opt {
        for id in joined {
            let name = names_current.get(&id).cloned().unwrap_or(id.clone());
            discord_embed(&hook, &format!("Player joined: {}", name), COLOR_INFO).await;
        }
        for id in left {
            let name = names_prev.get(&id).cloned().unwrap_or(id.clone());
            discord_embed(&hook, &format!("Player left: {}", name), COLOR_INFO).await;
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
    let res = api_post_value(&cfg, "announce", Some(body)).await;
    // Discord webhook log
    if let Some(hook) = cfg.discord_webhook.clone() {
        match &res {
            Ok(_) => discord_embed(&hook, &format!("Broadcast sent: {}", message), COLOR_SUCCESS).await,
            Err(e) => discord_embed(&hook, &format!("Broadcast failed: {}", e), COLOR_ERROR).await,
        }
    }
    res.map(|_| ()).map_err(|e| e.to_string())
}

// Utility: return raw /players JSON pretty-printed for debugging
#[tauri::command]
async fn dump_players_json(state: State<'_, AppState>) -> Result<String, String> {
    let cfg = state.config.lock().clone();
    api_get_value(&cfg, "players")
        .await
        .map(|v| serde_json::to_string_pretty(&v).unwrap_or_else(|_| v.to_string()))
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn force_save(state: State<'_, AppState>) -> Result<String, String> {
    let cfg = state.config.lock().clone();
    let base = cfg.base_url.clone();
    let pass = cfg.password.clone().unwrap_or_default();
    if let Some(h) = cfg.discord_webhook.clone() { discord_embed(&h, "Manual save requested.", COLOR_INFO).await; }

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
    if let Some(h) = cfg.discord_webhook.clone() { discord_embed(&h, &format!("Shutdown requested in {}s: {}", s, m), COLOR_INFO).await; }

    tauri::async_runtime::spawn({
        let cfg = cfg.clone();
        let m = m.clone();
        async move {
            let client = reqwest::Client::new();
            let base = cfg.base_url.clone();
            let pass = cfg.password.clone().unwrap_or_default();
            let _ = announce_multi(&client, &base, &pass, &format!("{} in {} seconds.", m, s)).await;
            if s > 1 { tokio::time::sleep(Duration::from_secs(s)).await; }
            // After waiting, send minimal waittime accepted by some providers
            let bodies = [
                serde_json::json!({ "waittime": 1, "message": &m }),
                serde_json::json!({ "seconds": 1,  "message": &m }),
                serde_json::json!({ "time": 1,     "message": &m }),
                serde_json::json!({ "duration": 1, "message": &m }),
            ];
            for b in bodies {
                if api_post_value(&cfg, "shutdown", Some(b)).await.is_ok() {
                    if let Some(h) = cfg.discord_webhook.clone() { let _ = discord_embed(&h, "Shutdown command sent.", COLOR_INFO).await; }
                    return;
                }
            }
            let _ = api_post_value(&cfg, "shutdown", None).await;
            if let Some(h) = cfg.discord_webhook.clone() { let _ = discord_embed(&h, "Shutdown command sent.", COLOR_INFO).await; }
        }
    });
    Ok(())
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

    // Discord log of scheduling, then staged in-game countdown
    if let Some(hook) = cfg.discord_webhook.clone() {
        discord_embed(&hook, &format!("Manual restart scheduled in {} seconds.", lead), COLOR_INFO).await;
    }
    warn_countdown(&client, &base, &pass, lead, cfg.discord_webhook.clone()).await;

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
    if let Some(hook) = cfg.discord_webhook.clone() { discord_embed(&hook, "Manual restart executing.", COLOR_INFO).await; }
    let _ = attempt_shutdown(&base, &pass, cfg.discord_webhook.clone(), "Auto restart").await;

    // wait for REST to go down (max 120s) before starting new instance
    if let Some(hook) = cfg.discord_webhook.clone() {
        discord_embed(&hook, "Waiting for server to stop (up to 120s)...", COLOR_INFO).await;
    }
    let stopped = wait_for_server_down(&base, &pass, 120).await;
    if let Some(hook) = cfg.discord_webhook.clone() {
        if stopped {
            discord_embed(&hook, "Server appears offline. Starting new instance...", COLOR_SUCCESS).await;
        } else {
            discord_embed(&hook, "Server did not stop in time (120s). Starting anyway.", COLOR_ERROR).await;
        }
    }

    if let Some(c) = start_cmd {
        if let Some(hook) = cfg.discord_webhook.clone() { let _ = discord_embed(&hook, &format!("Starting server via: {}", c), COLOR_INFO).await; }
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
    state: State<'_, AppState>,
    src_override: Option<String>,
    dest_override: Option<String>,
) -> Result<String, String> {
    let cfg = state.config.lock().clone();
    if !cfg.allow_actions { return Err("actions disabled".into()); }
    let src_s = src_override
        .or(cfg.backup_dir.clone())
        .ok_or_else(|| "backup source not configured".to_string())?;
    let src = PathBuf::from(src_s);
    if !src.exists() {
        return Err(format!("backup source not found: {}", src.display()));
    }
    let dest_root = if let Some(d) = dest_override.or(cfg.backup_dest_dir.clone()) {
        PathBuf::from(d)
    } else {
        src.join("_backups")
    };
    let _ = std::fs::create_dir_all(&dest_root);
    let ts = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let dest = dest_root.join(format!("backup-{}.zip", ts));
    let src_clone = src.clone();
    let dest_clone = dest.clone();
    let result = tokio::task::spawn_blocking(move || zip_directory(&src_clone, &dest_clone))
        .await
        .map_err(|e| e.to_string())?;
    match result {
        Ok(()) => {
            if let Some(h) = cfg.discord_webhook.clone() {
                discord_embed(&h, &format!("Manual backup created: {}", dest.display()), COLOR_SUCCESS).await;
                match prune_old_backups(&dest_root, 3) {
                    Ok(n) if n > 0 => discord_embed(&h, &format!("Pruned {} backup(s) older than 3 days.", n), COLOR_INFO).await,
                    Ok(_) => {}
                    Err(e) => discord_embed(&h, &format!("Prune old backups failed: {}", e), COLOR_ERROR).await,
                }
            } else {
                let _ = prune_old_backups(&dest_root, 3);
            }
            Ok(dest.to_string_lossy().to_string())
        }
        Err(e) => {
            if let Some(h) = cfg.discord_webhook.clone() {
                discord_embed(&h, &format!("Manual backup failed: {}", e), COLOR_ERROR).await;
            }
            Err(e.to_string())
        }
    }
}

#[tauri::command]
fn cancel_restart() {
    RESTART_GEN.fetch_add(1, Ordering::SeqCst);
}

#[tauri::command]
async fn unban_player(state: State<'_, AppState>, player_id: String) -> Result<(), String> {
    let cfg = state.config.lock().clone();
    if !cfg.allow_actions { return Err("actions disabled".into()); }
    let hook = cfg.discord_webhook.clone();
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
                if let Some(h) = hook.clone() { discord_embed(&h, &format!("Unban succeeded: {}", player_id), COLOR_SUCCESS).await; }
                return Ok(());
            }
        }
        if api_post_value(&cfg, p, None).await.is_ok() {
            if let Some(h) = hook.clone() { discord_embed(&h, &format!("Unban succeeded: {}", player_id), COLOR_SUCCESS).await; }
            return Ok(());
        }
    }
    if let Some(h) = hook { discord_embed(&h, &format!("Unban failed: {}", player_id), COLOR_ERROR).await; }
    Err("unban failed".into())
}
#[tauri::command]
async fn kick_player(state: State<'_, AppState>, player_id: String) -> Result<(), String> {
    let cfg = state.config.lock().clone();
    if !cfg.allow_actions { return Err("actions disabled".into()); }
    let hook = cfg.discord_webhook.clone();
    let bodies = [
        serde_json::json!({ "steamId": player_id }),
        serde_json::json!({ "playerId": player_id }),
        serde_json::json!({ "id": player_id }),
    ];
    for b in bodies {
        if api_post_value(&cfg, "kick", Some(b)).await.is_ok() {
            if let Some(h) = hook.clone() { discord_embed(&h, &format!("Kick succeeded: {}", player_id), COLOR_SUCCESS).await; }
            return Ok(());
        }
    }
    match api_post_value(&cfg, "kick", None).await {
        Ok(_) => {
            if let Some(h) = hook { discord_embed(&h, &format!("Kick succeeded: {}", player_id), COLOR_SUCCESS).await; }
            Ok(())
        }
        Err(e) => {
            if let Some(h) = cfg.discord_webhook.clone() { discord_embed(&h, &format!("Kick failed: {} ({})", player_id, e), COLOR_ERROR).await; }
            Err(e.to_string())
        }
    }
}

#[tauri::command]
async fn ban_player(state: State<'_, AppState>, player_id: String) -> Result<(), String> {
    let cfg = state.config.lock().clone();
    if !cfg.allow_actions { return Err("actions disabled".into()); }
    let hook = cfg.discord_webhook.clone();
    let bodies = [
        serde_json::json!({ "steamId": player_id }),
        serde_json::json!({ "playerId": player_id }),
        serde_json::json!({ "id": player_id }),
    ];
    for b in bodies {
        if api_post_value(&cfg, "ban", Some(b)).await.is_ok() {
            if let Some(h) = hook.clone() { discord_embed(&h, &format!("Ban succeeded: {}", player_id), COLOR_SUCCESS).await; }
            return Ok(());
        }
    }
    match api_post_value(&cfg, "ban", None).await {
        Ok(_) => {
            if let Some(h) = hook { discord_embed(&h, &format!("Ban succeeded: {}", player_id), COLOR_SUCCESS).await; }
            Ok(())
        }
        Err(e) => {
            if let Some(h) = cfg.discord_webhook.clone() { discord_embed(&h, &format!("Ban failed: {} ({})", player_id, e), COLOR_ERROR).await; }
            Err(e.to_string())
        }
    }
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
    let hook = cfg.discord_webhook.clone();

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
            let remaining = (next_dt - now).num_seconds().max(0) as u64;
            warn_countdown(&client, &base, &pass, remaining, hook.clone()).await;

            if sched.load(Ordering::SeqCst) != my_id {
                break;
            }
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

            if let Some(h) = hook.clone() { let _ = discord_embed(&h, "Auto-restart executing.", COLOR_INFO).await; }
            // try various shutdown shapes
            let bodies = [
                serde_json::json!({ "waittime": 1, "message": "Auto restart" }),
                serde_json::json!({ "seconds": 1,  "message": "Auto restart" }),
                serde_json::json!({ "time": 1,     "message": "Auto restart" }),
                serde_json::json!({ "duration": 1, "message": "Auto restart" }),
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

            // Extra robust attempt with detailed Discord logging
            let _ = attempt_shutdown(&base, &pass, hook.clone(), "Auto restart").await;

            // wait for REST to go down (max 120s) before starting new instance
            if let Some(h) = hook.clone() { let _ = discord_embed(&h, "Waiting for server to stop (up to 120s)...", COLOR_INFO).await; }
            let stopped = wait_for_server_down(&base, &pass, 120).await;
            if let Some(h) = hook.clone() {
                if stopped {
                    let _ = discord_embed(&h, "Server appears offline. Starting new instance...", COLOR_SUCCESS).await;
                } else {
                    let _ = discord_embed(&h, "Server did not stop in time (120s). Starting anyway.", COLOR_ERROR).await;
                }
            }

            if let Some(c) = &cmd {
                if let Some(h) = hook.clone() { let _ = discord_embed(&h, &format!("Starting server via: {}", c), COLOR_INFO).await; }
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
            config: Mutex::new(load_saved_config().unwrap_or_default()),
            tracker: Mutex::new(PlayerTracker::default()),
            sched: Arc::new(AtomicUsize::new(0)),
            last_players: Mutex::new(HashSet::new()),
            last_names: Mutex::new(HashMap::new()),
            autosave_gen: Arc::new(AtomicUsize::new(0)),
            backup_gen: Arc::new(AtomicUsize::new(0)),
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            set_config,
            get_server_info,
            get_players,
            dump_players_json,
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
        // Devtools no longer auto-open; keep setup minimal
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

