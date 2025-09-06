import { invoke } from "@tauri-apps/api/core";
import * as path from "@tauri-apps/api/path";
import * as fs from "@tauri-apps/plugin-fs";
import { exit } from "@tauri-apps/plugin-process";
import { ConfigIniParser } from "config-ini-parser";
import { fetch } from "@tauri-apps/plugin-http";
import {
  GetApiRequestResponse,
  checkConnection,
} from "../src/api_functions.ts";

var resourceDirPath: string;
var serverIp: string;
var serverPort: string;
var serverPassword: string;

window.addEventListener("DOMContentLoaded", async () => {
  resourceDirPath = await path.resourceDir();
  const exists = await fs.exists(
    await path.join(resourceDirPath, "pal_api_config.ini")
  );

  if (exists) {
    await getConfigData();
    invoke("store_server_info", {
      new_ip: serverIp,
      new_port: serverPort,
      new_password: serverPassword,
    });
  }

  const serverLoginInfo = (await invoke("get_server_info")) as String;
  if (serverLoginInfo == "::") {
    window.location.href = "/login/";
  }

  let servInfo = serverLoginInfo.trim().split(":");
  serverIp = servInfo[0];
  serverPort = servInfo[1];
  serverPassword = servInfo[2];

  const conStatus = await checkConnection(serverIp, serverPort, serverPassword);
  console.log(conStatus);
  if (conStatus != 200) {
    window.location.href = "/login/";
  };

  await displayServerInfo();
});

async function getConfigData() {
  const text = await fs.readTextFile(
    await path.join(resourceDirPath, "pal_api_config.ini")
  );
  let parser = new ConfigIniParser();
  parser.parse(text);
  serverPort = parser.get("ServerInfo", "port");
  serverPassword = parser.get("ServerInfo", "password");
  serverIp = parser.get("ServerInfo", "ip");
}

async function displayServerInfo() {
  const json = await GetApiRequestResponse(
    "info",
    serverIp,
    serverPort,
    serverPassword
  );

  const serverNameEl = document.getElementById(
    "server-name"
  ) as HTMLParagraphElement;
  const serverDescEl = document.getElementById(
    "server-description"
  ) as HTMLParagraphElement;
  const serverGuidEl = document.getElementById(
    "server-guid"
  ) as HTMLParagraphElement;
  const serverVerEl = document.getElementById(
    "server-version"
  ) as HTMLParagraphElement;

  serverNameEl.innerHTML = json.servername;
  serverDescEl.innerHTML = json.description;
  serverGuidEl.innerHTML = json.worldguid;
  serverVerEl.innerHTML = json.version;
}
