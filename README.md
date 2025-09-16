# Palworld REST API Client

A desktop control panel for Palworld dedicated servers built with React, TypeScript, and Tauri. The app talks to the Palworld REST API so you can run day-to-day server operations without keeping a browser tab open.

## Features
- Live server overview showing name, map, uptime, and online players with per-player session timers
- Player management helpers for announcing messages, force-saving, kicking, or banning in one click
- Manual and scheduled restarts/shutdowns with in-game countdowns and optional Windows start commands
- Automatic 15-minute save loop plus zipped backups with retention pruning and manual override
- Discord webhook notifications for important events (config updates, restarts, saves, backups)
- Read-only safety mode when you want to monitor without issuing disruptive actions

## Prerequisites
- Node.js 18+ (with npm)
- Rust stable toolchain and Cargo (https://rustup.rs/)
- Tauri tooling for your platform (https://tauri.app/start/prerequisites/)
- Palworld server with the REST API enabled and reachable from the machine running this app

## Getting Started
1. Clone this repository and open it in your editor of choice.
2. Install JavaScript dependencies:
   ```bash
   npm install
   ```
3. Start the desktop app in development mode:
   ```bash
   npm run tauri dev
   ```
   This runs the Vite dev server and launches the Tauri shell so you can develop the UI and Rust backend together.

### Useful Scripts
- `npm run dev` – run only the Vite dev server in a browser window
- `npm run build` – type-check and emit the production web assets into `dist/`
- `npm run tauri dev` – run the full Tauri desktop app with hot reload
- `npm run tauri build` – produce a distributable (MSI on Windows) in `src-tauri/target`

## Configuration & Usage
Open the app and press **Settings** to configure how it reaches your server.

- **Base URL**: the REST endpoint root. The UI will normalize the value (add `http://`, default port `8212`, and append `/v1/api` when missing).
- **Admin password**: used for HTTP basic auth when calling Palworld endpoints.
- **Restart times**: comma-separated `HH:MM` times in your local timezone for automatic restarts.
- **Start command**: optional `.bat` or `.exe` path that should be launched after a restart or shutdown.
- **Backup source/destination**: folders for zipped backups. Destination defaults to `<source>/_backups`.
- **Discord webhook URL**: receives embeds for saves, restarts, backups, and config changes.
- **Allow actions**: toggle to put the UI in read-only mode; background jobs pause while disabled.

Settings are persisted as JSON at the operating system's config directory (Windows: `%APPDATA%\palworld-rest-api-client\config.json`, macOS: `~/Library/Application Support/palworld-rest-api-client/config.json`, Linux: `~/.config/palworld-rest-api-client/config.json`).

## Automation Details
Once settings are saved with actions allowed:
- The backend issues an auto-save every 15 minutes via `/save`.
- Scheduled restart tasks watch the clock and execute when a configured time arrives, announcing in game and (optionally) to Discord.
- Backups compress the configured source directory to timestamped ZIP files, pruning files older than three days.
- Manual buttons in the UI (Broadcast, Save, Kick, Ban, Restart, Shutdown, Backup Now) call matching Tauri commands under the hood.

## Project Layout
- `src/` – React + TypeScript front end (main dashboard UI lives in `components/Dashboard.tsx`).
- `src-tauri/` – Rust backend, Tauri config, and bundler assets. `src/main.rs` contains the REST orchestration and background tasks.
- `dist/` – generated web assets (ignored by git).

## License
This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.
