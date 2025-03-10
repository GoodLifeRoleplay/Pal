import { fetch } from "@tauri-apps/plugin-http";

export async function GetApiRequestResponse(target: string, ip: string, port: string, password: string) {
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
  
  export async function SendApiRequest(target: string, message: string, ip: string, port: string, password: string) {
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
  
    return response.status
  }

  export async function checkConnection(ip: string, port: string, password: string){
    let url = `http://${ip}:${port}/v1/api/info`;
  
    try{
        const response = await fetch(url, {
            method: 'GET',
            credentials: 'same-origin',
            redirect: 'follow',
            headers: {
                "Content-Type": "text/plain",
                'Authorization': 'Basic ' + btoa(`admin:${password}`),
            },
        });

        console.log(response)
      
        return response.status;

    }catch(e){
        return 400
    }
}