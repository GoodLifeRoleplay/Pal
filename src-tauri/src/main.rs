#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

use anyhow::Result;                  // <- drop `Context`
use chrono::{DateTime, Local};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, fs, io::{Write, Read}, path::{Path, PathBuf}, time::Duration};
use tauri::{State};                  // <- drop `Manager`
use tokio::{task::JoinHandle, time::sleep};
use walkdir::WalkDir;
use zip::write::FileOptions;

#[derive(Clone, Serialize, Deserialize, Default)]   // <-- add Default here
struct ApiConfig {
  base_url: String,
  token: Option<String>,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
struct Player {
  id: String,         // SteamID or GUID from the REST API
  name: String,
  level: Option<u32>,
  ping: Option<u32>,
}

#[derive(Clone, Serialize, Deserialize)]
struct ServerInfo {
  name: String,
  map: Option<String>,
  players_online: usize,
  max_players: Option<usize>,
  uptime_seconds: Option<u64>,
}

#[derive(Clone, Serialize, Deserialize, Default)]
struct SessionInfo {
  first_seen: DateTime<Local>,
  last_seen: DateTime<Local>,
}

#[derive(Default)]
struct SessionTracker {
  // id -> session
  sessions: HashMap<String, SessionInfo>,
}

impl SessionTracker {
  fn update_with(&mut self, players: &[Player]) {
    let now = Local::now();
    let present: std::collections::HashSet<_> = players.iter().map(|p| p.id.clone()).collect();

    for p in players {
      self.sessions.entry(p.id.clone()).and_modify(|s| {
        s.last_seen = now;
      }).or_insert(SessionInfo {
        first_seen: now,
        last_seen: now,
      });
    }

    // Optionally prune sessions that are gone for a long time (not required).
    let to_prune: Vec<String> = self.sessions.iter()
      .filter(|(id, _)| !present.contains(&id.to_string()))
      .filter(|(_, s)| (now - s.last_seen).num_minutes() > 120) // two hours gone
      .map(|(id, _)| id.clone()).collect();

    for id in to_prune { self.sessions.remove(&id); }
  }

  fn durations(&self) -> HashMap<String, i64> {
    let now = Local::now();
    self.sessions.iter().map(|(id, s)| {
      let secs = (now - s.first_seen).num_seconds().max(0);
      (id.clone(), secs)
    }).collect()
  }
}

#[derive(Default)]
struct AutoRestartState {
  handle: Option<JoinHandle<()>>,
  enabled: bool,
}

#[derive(Default)]
struct AppState {
  config: Mutex<ApiConfig>,
  tracker: Mutex<SessionTracker>,
  auto: Mutex<AutoRestartState>,
}

#[derive(thiserror::Error, Debug)]
enum AppErr {
  #[error("Unauthorized")]
  Unauthorized,
  #[error("{0}")]
  Other(String),
}

fn auth_header(token: &Option<String>) -> Vec<(reqwest::header::HeaderName, String)> {
  match token {
    Some(t) if !t.is_empty() => {
      vec![(reqwest::header::AUTHORIZATION, format!("Bearer {}", t))]
    }
    _ => vec![],
  }
}

async fn api_get<T: for<'de> Deserialize<'de>>(cfg: &ApiConfig, path: &str) -> Result<T> {
  let url = format!("{}/{}", cfg.base_url.trim_end_matches('/'), path.trim_start_matches('/'));
  let mut req = reqwest::Client::new().get(url);
  for (k, v) in auth_header(&cfg.token) {
    req = req.header(k, v);
  }
  let res = req.send().await?;
  if res.status() == 401 { return Err(AppErr::Unauthorized.into()); }
  Ok(res.json::<T>().await?)
}

async fn api_post(cfg: &ApiConfig, path: &str, body: serde_json::Value) -> Result<()> {
  let url = format!("{}/{}", cfg.base_url.trim_end_matches('/'), path.trim_start_matches('/'));
  let mut req = reqwest::Client::new().post(url).json(&body);
  for (k, v) in auth_header(&cfg.token) {
    req = req.header(k, v);
  }
  let res = req.send().await?;
  if res.status() == 401 { return Err(AppErr::Unauthorized.into()); }
  if !res.status().is_success() {
    return Err(AppErr::Other(format!("HTTP {}", res.status())).into());
  }
  Ok(())
}

// ---- Backups ----------------------------------------------------------------

fn zip_dir(src: &Path, zip_path: &Path) -> Result<()> {
  let file = fs::File::create(zip_path)?;
  let mut zip = zip::ZipWriter::new(file);
  let options = FileOptions::default().compression_method(zip::CompressionMethod::Deflated);

  let src_str = src.to_string_lossy().to_string();

  for entry in WalkDir::new(src) {
    let entry = entry?;
    let path = entry.path();
    let name = path.strip_prefix(src).unwrap().to_string_lossy();

    if path.is_file() {
      zip.start_file(name.replace('\\', "/"), options)?;
      let mut f = fs::File::open(path)?;
      let mut buf = Vec::new();
      f.read_to_end(&mut buf)?;
      zip.write_all(&buf)?;
    } else if !name.is_empty() {
      zip.add_directory(name.replace('\\', "/"), options)?;
    }
  }

  zip.finish()?;
  println!("[backup] zipped {}", src_str);
  Ok(())
}

fn desktop_backup_dir() -> PathBuf {
  let home = dirs::desktop_dir().unwrap_or(std::env::current_dir().unwrap());
  home.join("PalworldBackups")
}

// ---- Commands callable from the UI ------------------------------------------

#[tauri::command]
async fn set_api_config(state: State<'_, AppState>, cfg: ApiConfig) -> Result<(), String> {
  *state.config.lock() = cfg;
  Ok(())
}

#[tauri::command]
async fn get_server_info(state: State<'_, AppState>) -> Result<ServerInfo, String> {
  let cfg = state.config.lock().clone();
  api_get::<ServerInfo>(&cfg, "server/info").await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_players(state: State<'_, AppState>) -> Result<Vec<Player>, String> {
  let cfg = state.config.lock().clone();
  let players = api_get::<Vec<Player>>(&cfg, "server/players").await.map_err(|e| e.to_string())?;
  state.tracker.lock().update_with(&players);
  Ok(players)
}

#[tauri::command]
async fn player_durations(state: State<'_, AppState>) -> Result<HashMap<String, i64>, String> {
  Ok(state.tracker.lock().durations())
}

#[tauri::command]
async fn broadcast(state: State<'_, AppState>, message: String) -> Result<(), String> {
  let cfg = state.config.lock().clone();
  api_post(&cfg, "server/broadcast", serde_json::json!({ "message": message })).await
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn force_save(state: State<'_, AppState>) -> Result<(), String> {
  let cfg = state.config.lock().clone();
  api_post(&cfg, "server/save", serde_json::json!({})).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn shutdown(state: State<'_, AppState>, delay_secs: u64) -> Result<(), String> {
  let cfg = state.config.lock().clone();
  api_post(&cfg, "server/shutdown", serde_json::json!({ "delay": delay_secs }))
    .await.map_err(|e| e.to_string())
}

#[derive(Serialize, Deserialize, Clone)]
struct AutoRestartConfig {
  interval_minutes: u64,       // how often to do the cycle
  save_dir: String,            // folder that contains the Palworld save
  start_command: Option<String> // optional command to start the server after shutdown
}

#[tauri::command]
async fn run_backup(save_dir: String) -> Result<String, String> {
  let src = PathBuf::from(save_dir);
  if !src.exists() { return Err("Save dir not found".into()); }
  let root = desktop_backup_dir();
  fs::create_dir_all(&root).map_err(|e| e.to_string())?;
  let stamp = Local::now().format("%Y%m%d-%H%M%S").to_string();
  let zip_path = root.join(format!("palworld-save-{}.zip", stamp));
  zip_dir(&src, &zip_path).map_err(|e| e.to_string())?;
  Ok(zip_path.to_string_lossy().to_string())
}

#[tauri::command]
async fn start_auto_restart(state: State<'_, AppState>, cfg: AutoRestartConfig) -> Result<(), String> {
  // stop any existing worker
  stop_auto_restart(state.clone()).await.ok();

  // capture current API config NOW so the background task has it
  let api_cfg = { state.config.lock().clone() };

  let handle = tokio::spawn(async move {
    loop {
      // 1) Save
      let _ = api_post(&api_cfg, "server/save", serde_json::json!({})).await;

      // 2) Backup
      let _ = run_backup(cfg.save_dir.clone()).await;

      // 3) Shutdown (60s)
      let _ = api_post(&api_cfg, "server/shutdown", serde_json::json!({ "delay": 60 })).await;

      // 4) Optional start command after grace period
      sleep(Duration::from_secs(70)).await;
      if let Some(cmd) = &cfg.start_command {
        let _ = std::process::Command::new("cmd").args(["/C", cmd]).spawn();
      }

      // 5) Wait for next interval
      sleep(Duration::from_secs(cfg.interval_minutes * 60)).await;
    }
  });

  {
    let mut auto = state.auto.lock();
    auto.enabled = true;
    auto.handle = Some(handle);
  }
  Ok(())
}

#[tauri::command]
async fn stop_auto_restart(state: State<'_, AppState>) -> Result<(), String> {
  let mut auto = state.auto.lock();
  auto.enabled = false;
  if let Some(h) = auto.handle.take() {
    h.abort();
  }
  Ok(())
}

fn main() {
  tauri::Builder::default()
    .manage(AppState::default())
    .invoke_handler(tauri::generate_handler![
      set_api_config,
      get_server_info,
      get_players,
      player_durations,
      broadcast,
      force_save,
      shutdown,
      run_backup,
      start_auto_restart,
      stop_auto_restart
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
