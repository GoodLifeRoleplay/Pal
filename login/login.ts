import { invoke } from "@tauri-apps/api/core";
import * as path from "@tauri-apps/api/path";
import * as fs from "@tauri-apps/plugin-fs";
import { exit } from "@tauri-apps/plugin-process";
import { ConfigIniParser } from "config-ini-parser";
import { fetch } from "@tauri-apps/plugin-http";
import { checkConnection } from "../src/api_functions.ts";

var resourceDirPath: string;
var serverIp: string;
var serverPort: string;
var serverPassword: string;

window.addEventListener("DOMContentLoaded", async () => {
  resourceDirPath = await path.resourceDir();

  const submitButton = document.getElementById("submit") as HTMLButtonElement;
  submitButton.addEventListener("click", login);
});

async function login() {
  const serverIpElement = document.getElementById(
    "server-ip"
  ) as HTMLInputElement;
  const serverPortElement = document.getElementById(
    "server-port"
  ) as HTMLInputElement;
  const serverPasswordElement = document.getElementById(
    "server-password"
  ) as HTMLInputElement;

  const checkBox = document.getElementById("checkbox") as HTMLInputElement;

  serverIp = serverIpElement.value;
  serverPort = serverPortElement.value;
  serverPassword = serverPasswordElement.value;

  const connectionStatus = await checkConnection(serverIp, serverPort, serverPassword)

  if (connectionStatus != 200){
    const err = document.getElementById('err') as HTMLElement;
    err.innerHTML = `There was an error connecting to the server, response: ${connectionStatus}. Please make sure to input the correct information`;
    err.classList.remove('invisible');
    return
  }

  invoke("store_server_info", {
    new_ip: serverIp,
    new_port: serverPort,
    new_password: serverPassword,
  });

  if (checkBox.checked){
    await createConfigFile();
  }

  window.location.href = "/info/";
}

async function createConfigFile() {
  try {
    const file = await fs.create(
      await path.join(resourceDirPath, "pal_api_config.ini")
    );
    await file.write(
      new TextEncoder().encode(
        `[ServerInfo]\nport=${serverPort}\npassword=${serverPassword}\nip=${serverIp}`
      )
    );
    await file.close();
  } catch (e) {
    console.error(e);
  }
}


