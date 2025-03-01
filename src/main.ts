// import { invoke } from "@tauri-apps/api/core";
import * as path from '@tauri-apps/api/path';
import * as fs from '@tauri-apps/plugin-fs';
import { exit } from '@tauri-apps/plugin-process';
import { ConfigIniParser } from "config-ini-parser";
import { fetch } from '@tauri-apps/plugin-http';

var resourceDirPath: string;
var port: string;
var password: string;
var ip: string;
var currentNav = "info";


window.addEventListener("DOMContentLoaded", async() => {

  resourceDirPath = await path.resourceDir();

  await CheckConfigExists();

  await Info();

  document.getElementById("info")!.addEventListener("click", Info);
  document.getElementById("players")!.addEventListener("click", Players);
  document.getElementById("settings")!.addEventListener("click", Settings);
  document.getElementById("metrics")!.addEventListener("click", Metrics);
  document.getElementById("message")!.addEventListener("click", Message);
  document.getElementById("kick")!.addEventListener("click", Kick);
  document.getElementById("ban")!.addEventListener("click", Ban);
  document.getElementById("unban")!.addEventListener("click", Unban);
  document.getElementById("save")!.addEventListener("click", Save);
  document.getElementById("shutdown")!.addEventListener("click", Shutdown);

});

// check if ini file exists, if not create it and close app, otherwise read and parse the ini file
async function CheckConfigExists(){
  const exists = await fs.exists(await path.join(resourceDirPath, 'pal_api_config.ini'));
  if (!exists) {
    const file = await fs.create(await path.join(resourceDirPath, 'pal_api_config.ini'));
    await file.write(new TextEncoder().encode('[ServerInfo]\nport=8212\npassword=changeme\nip=127.0.0.1'));
    await file.close();
    await exit(1);
  }else{
    await ReadIniFile();
  }
}

async function Info(){
  const json = await GetApiRequestResponse("info");
  document.getElementById("content")!.innerHTML = "";

  const servernameP = document.createElement("p");
  servernameP.innerHTML = `Server Name: ${json.servername}`;
  document.getElementById("content")!.appendChild(servernameP);

  const descriptionP = document.createElement("p");
  descriptionP.innerHTML = `Server Description: ${json.Description}`;
  document.getElementById("content")!.appendChild(descriptionP);

  const worldguidP = document.createElement("p");
  worldguidP.innerHTML = `World GUID: ${json.worldguid}`;
  document.getElementById("content")!.appendChild(worldguidP);

  const versionP = document.createElement("p");
  versionP.innerHTML = `Server Version: ${json.version}`;
  document.getElementById("content")!.appendChild(versionP);

  document.getElementById(currentNav)!.className = "";
  currentNav = "info";
  document.getElementById(currentNav)!.className = "active";
  
}

async function Players(){
  const json = await GetApiRequestResponse("players");
  const table = buildHtmlTable(json.players);
  
  document.getElementById("content")!.innerHTML = table;
  document.getElementById(currentNav)!.className = "";
  currentNav = "players";
  document.getElementById(currentNav)!.className = "active";
}

function buildHtmlTable(myList:any[]) {
  let columns:string[];
  columns=[];
  let res = '<table class="table">';
  let headerTr = '';

  for (var i = 0; i < myList.length; i++) {
      var rowHash = myList[i];
      for (var key in rowHash) {
        if (key == "location_x" || key == "location_y" || key == "building_count") continue;
          if (!columns.some(x=>x==key)) {
              columns.push(key);
              headerTr+='<th>'+key+'</th>';
          }
      }
  }
  res += "<tr>"+headerTr+"</tr>";

  for (var i = 0; i < myList.length; i++) {
    let row = '';
    for (var colIndex = 0; colIndex < columns.length; colIndex++) {
      var cellValue = myList[i][columns[colIndex]];
      console.log(cellValue);
      if (cellValue == null) cellValue = "";
      row+='<td>'+cellValue+'</td>';
    }
    res += "<tr>"+row+"</tr>";
  }
  res += "</table>";
  return res;
}

async function Settings(){
  const json = await GetApiRequestResponse("settings");
  document.getElementById("content")!.innerHTML = "";

  for (var key in json) {
    let p = document.createElement("p");
    p.innerHTML = `${key}: ${json[key]}`;
    document.getElementById("content")!.appendChild(p);
  }
  document.getElementById(currentNav)!.className = "";
  currentNav = "settings";
  document.getElementById(currentNav)!.className = "active";

}

async function Metrics(){
  const json = await GetApiRequestResponse("metrics");
  document.getElementById("content")!.innerHTML = "";  

  for (var key in json) {
    let p = document.createElement("p");
    p.innerHTML = `${key}: ${json[key]}`;
    document.getElementById("content")!.appendChild(p);
  }
  document.getElementById(currentNav)!.className = "";
  currentNav = "metrics";
  document.getElementById(currentNav)!.className = "active";
}

async function Message(){
  document.getElementById("content")!.innerHTML = "";

  const input = document.createElement("input");
  input.setAttribute("type", "text");
  input.setAttribute("id", "send");
  input.setAttribute("placeholder", "Enter message here");
  document.getElementById("content")!.appendChild(input);
  
  const button = document.createElement("button");
  button.innerHTML = "Send";
  button.addEventListener("click", SendMessage);
  document.getElementById("content")!.appendChild(button);

  document.getElementById(currentNav)!.className = "";
  currentNav = "message";
  document.getElementById(currentNav)!.className = "active";
}

async function SendMessage(){
  const message = (document.getElementById("send") as HTMLInputElement).value;
  let data = JSON.stringify({
    "message": message
  });
  SendApiRequest("announce", data);
}

async function Kick(){
  document.getElementById("content")!.innerHTML = "";

  let dropdown = document.createElement('select')
  dropdown.id = 'sel'
  dropdown.onfocus = PopulateDropdown

  const option = document.createElement('option');
  option.value = "-1";
  option.textContent = 'Select a player';
  dropdown.appendChild(option);

  document.getElementById("content")!.appendChild(dropdown);

  let button = document.createElement('button')
  button.id = 'kick-btn'
  button.onclick = KickPlayer
  button.innerHTML = 'Kick'
  document.getElementById("content")!.appendChild(button);

  document.getElementById(currentNav)!.className = "";
  currentNav = "kick";
  document.getElementById(currentNav)!.className = "active";
}

async function PopulateDropdown(){
  const json = await GetApiRequestResponse("players");

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

async function KickPlayer(){
  const player = (document.getElementById("sel") as HTMLSelectElement).value;
  
  if(player == "-1") return;

  let data = JSON.stringify({
    "userid": player,
    "message": `${player} was kicked by an admin`
  });
  SendApiRequest("kick", data);
}

async function Ban(){
  document.getElementById("content")!.innerHTML = "";

  let dropdown = document.createElement('select')
  dropdown.id = 'sel'
  dropdown.onfocus = PopulateDropdown

  const option = document.createElement('option');
  option.value = "-1";
  option.textContent = 'Select a player';
  dropdown.appendChild(option);

  document.getElementById("content")!.appendChild(dropdown);

  let button = document.createElement('button')
  button.id = 'ban-btn'
  button.onclick = BanPlayer
  button.innerHTML = 'Ban'
  document.getElementById("content")!.appendChild(button);



  document.getElementById(currentNav)!.className = "";
  currentNav = "ban";
  document.getElementById(currentNav)!.className = "active";
} 

async function BanPlayer(){
  const player = (document.getElementById("sel") as HTMLSelectElement).value;
  
  if(player == "-1") return;

  let data = JSON.stringify({
    "userid": player,
    "message": `${player} was banned by an admin`
  });
  SendApiRequest("ban", data);
}

async function Unban(){
  document.getElementById("content")!.innerHTML = "";

  const input = document.createElement("input");
  input.setAttribute("type", "text");
  input.setAttribute("id", "send");
  input.setAttribute("placeholder", "Enter message here");
  document.getElementById("content")!.appendChild(input);
  
  const button = document.createElement("button");
  button.innerHTML = "Send";
  button.addEventListener("click", UnbanPlayer);
  document.getElementById("content")!.appendChild(button);

  document.getElementById(currentNav)!.className = "";
  currentNav = "unban";
  document.getElementById(currentNav)!.className = "active";
}

async function UnbanPlayer(){
  const id = (document.getElementById("send") as HTMLInputElement).value;
  
  if(id == "") return;

  let data = JSON.stringify({
    "userid": id,
  });
  SendApiRequest("unban", data);
}

async function Save(){
  document.getElementById("content")!.innerHTML = "Saved the server!";

  let data = JSON.stringify({
    "message": "Save initiated by admin"
  });
  SendApiRequest("announce", data);

  SendApiRequest("save", "");

  document.getElementById(currentNav)!.className = "";
  currentNav = "save";
  document.getElementById(currentNav)!.className = "active";
} 

async function Shutdown(){
  document.getElementById("content")!.innerHTML = "";

  const input = document.createElement("input");
  input.setAttribute("type", "number");
  input.setAttribute("id", "send");
  input.setAttribute("placeholder", "time in seconds");
  document.getElementById("content")!.appendChild(input);
  
  const button = document.createElement("button");
  button.innerHTML = "Shutdown";
  button.addEventListener("click", ShutdownServer);
  document.getElementById("content")!.appendChild(button);

  document.getElementById(currentNav)!.className = "";
  currentNav = "shutdown";
  document.getElementById(currentNav)!.className = "active";
} 

async function ShutdownServer(){
  const time = (document.getElementById("send") as HTMLInputElement).value;
  
  if(time == "" || time == "0") return;

  let data = JSON.stringify({
    "waittime": time,
    "message": `Server will shutdown in ${time} seconds.`
  });
  SendApiRequest("shutdown", data);
}

async function ReadIniFile(){
  const text = await fs.readTextFile(await path.join(resourceDirPath, 'pal_api_config.ini'));
  let parser = new ConfigIniParser();
  parser.parse(text);
  port = parser.get("ServerInfo", "port");
  password = parser.get("ServerInfo", "password");
  ip = parser.get("ServerInfo", "ip");
}

async function GetApiRequestResponse(target: string) {
  let url = `http://${ip}:${port}/v1/api/${target}`;

  const response = await fetch(url, {
      method: 'GET',
      credentials: 'same-origin',
      redirect: 'follow',
      headers: {
          "Content-Type": "text/plain",
          'Authorization': 'Basic ' + btoa(`admin:${password}`),
      },
  });

  if (response.status == 200) {
      const json = await response.json();            
      return json;
  }
}

async function SendApiRequest(target: string, message: string) {
  let url = `http://${ip}:${port}/v1/api/${target}`;

  

  const response = await fetch(url, {
      method: 'Post',
      credentials: 'same-origin',
      redirect: 'follow',
      headers: {
          "Content-Type": "text/plain",
          'Authorization': 'Basic ' + btoa(`admin:${password}`),
      },
      body: message
  });

  console.log(response.status);
}