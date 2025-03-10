// import { invoke } from "@tauri-apps/api/core";
import * as path from "@tauri-apps/api/path";
import * as fs from "@tauri-apps/plugin-fs";
// import { exit } from '@tauri-apps/plugin-process';
// import { ConfigIniParser } from "config-ini-parser";
// import { fetch } from "@tauri-apps/plugin-http";

var resourceDirPath: string;

window.addEventListener("DOMContentLoaded", async () => {
  resourceDirPath = await path.resourceDir();
  const exists = await fs.exists(await path.join(resourceDirPath, 'pal_api_config.ini'));
  if (!exists) 
     window.location.href = '/login/';
  else {
    window.location.href = '/info/';
  }
});