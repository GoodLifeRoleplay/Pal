static mut ip: String = String::new();
static mut port: String = String::new();
static mut password: String = String::new();

#[tauri::command(rename_all = "snake_case")]
fn store_server_info(new_ip: &str, new_port: &str, new_password: &str){
    unsafe {
        ip = new_ip.to_string();
        port = new_port.to_string();
        password = new_password.to_string();
    }
}

#[tauri::command(rename_all = "snake_case")]
fn get_server_info() -> String {
    unsafe {
        format!("{}:{}:{}", ip, port, password)
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![store_server_info, get_server_info])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
