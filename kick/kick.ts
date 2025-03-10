import { invoke } from "@tauri-apps/api/core";
import * as path from "@tauri-apps/api/path";
import * as fs from "@tauri-apps/plugin-fs";
import { exit } from "@tauri-apps/plugin-process";
import { ConfigIniParser } from "config-ini-parser";
import { fetch } from "@tauri-apps/plugin-http";
import {
    GetApiRequestResponse,
    checkConnection,
    SendApiRequest
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

    const kickBtn = document.getElementById('kick') as HTMLButtonElement;
    kickBtn.addEventListener("click", kickPlayer);

    const dropdown = document.getElementById('sel') as HTMLSelectElement;
    dropdown.onfocus = populateDropdown;

    populateDropdown();

});

async function kickPlayer() {
    const player = (document.getElementById("sel") as HTMLSelectElement).value;
    const responseEl = document.getElementById('res') as HTMLElement;

    if (player == "-1") {
        responseEl.classList.remove('invisible');
        responseEl.classList.add('text-danger');
        responseEl.innerHTML = `You must select a player to kick from the dropdown`;
        return;
    }
    let data = JSON.stringify({
        "userid": player,
        "message": `${player} was kicked by an admin`
    });

    const responseStatus = await SendApiRequest("kick", data, serverIp, serverPort, serverPassword);

    if (responseStatus == 200) {
        responseEl.classList = "";
        responseEl.classList.add('text-success');
        responseEl.innerHTML = `Successfully kicked: ${player}`;
    } else {
        responseEl.classList = "";
        responseEl.classList.add('text-danger');
        responseEl.innerHTML = `There was a problem trying to kick: ${player}`;
    }
}

async function populateDropdown() {
    const responseEl = document.getElementById('res') as HTMLElement;
    responseEl.classList.add('invisible');

    const json = await GetApiRequestResponse("players", serverIp, serverPort, serverPassword);

    const dropdown = document.getElementById('sel')! as HTMLSelectElement;
    dropdown.options.length = 0;
    const option = document.createElement('option');
    option.value = "-1";
    option.textContent = 'Select a player';
    dropdown.appendChild(option);

    for (var i = 0; i < json.players.length; i++) {
        let option = document.createElement('option');
        option.value = json.players[i].userId;
        option.textContent = json.players[i].name;
        document.getElementById('sel')!.appendChild(option);
    }

}
