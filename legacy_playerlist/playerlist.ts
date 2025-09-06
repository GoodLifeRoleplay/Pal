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

  displayPlayers();
});

async function displayPlayers() {
  const json = await GetApiRequestResponse("players", serverIp, serverPort, serverPassword);
  const table = buildHtmlTable(json.players);

  document.getElementById("content")!.innerHTML = table;
}

function buildHtmlTable(myList: any[]) {
  let columns: string[];
  columns = [];
  let res = '<table class="table">';
  let headerTr = "";

  for (var i = 0; i < myList.length; i++) {
    var rowHash = myList[i];
    for (var key in rowHash) {
      if (key == "location_x" || key == "location_y" || key == "building_count")
        continue;
      if (!columns.some((x) => x == key)) {
        columns.push(key);
        headerTr += "<th>" + key + "</th>";
      }
    }
  }
  res += "<tr>" + headerTr + "</tr>";

  for (var i = 0; i < myList.length; i++) {
    let row = "";
    for (var colIndex = 0; colIndex < columns.length; colIndex++) {
      var cellValue = myList[i][columns[colIndex]];
      console.log(cellValue);
      if (cellValue == null) cellValue = "";
      row += "<td>" + cellValue + "</td>";
    }
    res += "<tr>" + row + "</tr>";
  }
  res += "</table>";
  return res;
}
