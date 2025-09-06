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

var serverIp: string;
var serverPort: string;
var serverPassword: string;

window.addEventListener("DOMContentLoaded", async () => {

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

    displayServerSettings();
});


async function displayServerSettings() {
    const json = await GetApiRequestResponse("settings", serverIp, serverPort, serverPassword);
    document.getElementById("content")!.innerHTML = "";

    for (var key in json) {
        let p = document.createElement("p");
        p.innerHTML = `${key}: ${json[key]}`;
        document.getElementById("content")!.appendChild(p);
    }
}