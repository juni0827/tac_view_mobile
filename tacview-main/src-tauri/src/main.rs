use reqwest::header::{HeaderMap, HeaderValue};
use serde::{Deserialize, Serialize};
use std::fs;
use std::net::TcpListener;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Manager;
use tauri::State;
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::{process::CommandChild, ShellExt};
use tokio::time::sleep;
use uuid::Uuid;

const SIDECAR_NAME: &str = "tac_view-sidecar";
const READY_PREFIX: &str = "READY ";
const DEFAULT_CONFIG_TEMPLATE: &str = "{\n  \"client\": {\n    \"googleApiKey\": \"\",\n    \"cesiumIonToken\": \"\"\n  },\n  \"server\": {\n    \"googleMapsApiKey\": \"\",\n    \"openskyClientId\": \"\",\n    \"openskyClientSecret\": \"\",\n    \"aisstreamApiKey\": \"\",\n    \"nswTransportApiKey\": \"\"\n  }\n}\n";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeClientConfig {
    google_api_key: String,
    cesium_ion_token: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeBootstrap {
    api_base_url: String,
    auth_token: String,
    client_config: RuntimeClientConfig,
    platform: String,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileRuntimeConfig {
    client: Option<FileClientConfig>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileClientConfig {
    google_api_key: Option<String>,
    cesium_ion_token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ReadySignal {
    port: u16,
    token: String,
    #[serde(rename = "configPath")]
    config_path: Option<String>,
}

struct AppState {
    bootstrap: RuntimeBootstrap,
    #[allow(dead_code)]
    sidecar: Mutex<Option<CommandChild>>,
}

#[tauri::command]
fn get_runtime_bootstrap(state: State<'_, AppState>) -> RuntimeBootstrap {
    state.bootstrap.clone()
}

fn ensure_config_file(config_path: &Path) -> Result<(), String> {
    if let Some(parent_dir) = config_path.parent() {
        fs::create_dir_all(parent_dir).map_err(|error| error.to_string())?;
    }

    if !config_path.exists() {
        fs::write(config_path, DEFAULT_CONFIG_TEMPLATE).map_err(|error| error.to_string())?;
    }

    Ok(())
}

fn next_local_port() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|error| error.to_string())?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    drop(listener);
    Ok(port)
}

fn read_client_config(config_path: &Path) -> Result<RuntimeClientConfig, String> {
    if !config_path.exists() {
        return Ok(RuntimeClientConfig {
            google_api_key: String::new(),
            cesium_ion_token: String::new(),
        });
    }

    let raw = fs::read_to_string(config_path).map_err(|error| error.to_string())?;
    let parsed: FileRuntimeConfig = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    let client = parsed.client.unwrap_or_default();

    Ok(RuntimeClientConfig {
        google_api_key: client.google_api_key.unwrap_or_default(),
        cesium_ion_token: client.cesium_ion_token.unwrap_or_default(),
    })
}

fn parse_ready_signal(line: &str) -> Option<ReadySignal> {
    line
        .trim()
        .strip_prefix(READY_PREFIX)
        .and_then(|payload| serde_json::from_str::<ReadySignal>(payload).ok())
}

async fn wait_for_health(port: u16, auth_token: &str) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(20);
    let client = reqwest::Client::new();

    while Instant::now() < deadline {
      let mut headers = HeaderMap::new();
      if !auth_token.is_empty() {
          let header_value = HeaderValue::from_str(auth_token).map_err(|error| error.to_string())?;
          headers.insert("x-tac-view-token", header_value);
      }

      let response = client
          .get(format!("http://127.0.0.1:{port}/api/health"))
          .headers(headers)
          .send()
          .await;

      if let Ok(response) = response {
          if response.status().is_success() {
              return Ok(());
          }
      }

      sleep(Duration::from_millis(250)).await;
    }

    Err("Timed out waiting for sidecar health check".to_string())
}

async fn start_sidecar(app: tauri::AppHandle) -> Result<AppState, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("tac_view");
    let config_path = app_data_dir.join("config.json");
    ensure_config_file(&config_path)?;

    let client_config = read_client_config(&config_path)?;
    let auth_token = Uuid::new_v4().to_string();
    let port = next_local_port()?;

    let sidecar_command = app
        .shell()
        .sidecar(SIDECAR_NAME)
        .map_err(|error| error.to_string())?
        .env("TAC_VIEW_CONFIG_PATH", config_path.to_string_lossy().to_string())
        .env("TAC_VIEW_AUTH_TOKEN", auth_token.clone())
        .env("TAC_VIEW_PORT", port.to_string());

    let (mut rx, child) = sidecar_command
        .spawn()
        .map_err(|error| format!("Failed to spawn sidecar: {error}"))?;

    let mut ready_signal: Option<ReadySignal> = None;
    let mut startup_logs: Vec<String> = Vec::new();
    let startup_deadline = Instant::now() + Duration::from_secs(20);

    while Instant::now() < startup_deadline {
        if let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line_bytes) => {
                    let line = String::from_utf8_lossy(&line_bytes).to_string();
                    if let Some(parsed) = parse_ready_signal(&line) {
                        ready_signal = Some(parsed);
                        break;
                    }
                    startup_logs.push(format!("stdout: {}", line.trim()));
                    if startup_logs.len() > 20 {
                        startup_logs.remove(0);
                    }
                    println!("[sidecar] {line}");
                }
                CommandEvent::Stderr(line_bytes) => {
                    let line = String::from_utf8_lossy(&line_bytes).to_string();
                    startup_logs.push(format!("stderr: {}", line.trim()));
                    if startup_logs.len() > 20 {
                        startup_logs.remove(0);
                    }
                    eprintln!("[sidecar] {line}");
                }
                CommandEvent::Error(error) => {
                    return Err(format!("Sidecar reported a startup error: {error}"));
                }
                CommandEvent::Terminated(payload) => {
                    return Err(format!(
                        "Sidecar terminated before startup completed (code: {:?}, signal: {:?}). Recent logs: {}",
                        payload.code,
                        payload.signal,
                        startup_logs.join(" | ")
                    ));
                }
                _ => {}
            }
        } else {
            break;
        }
    }

    let resolved_port = if let Some(ready) = &ready_signal {
        let _token = &ready.token;
        let _config_path = &ready.config_path;
        ready.port
    } else {
        wait_for_health(port, &auth_token).await.map_err(|error| {
            format!(
                "{error}. Recent sidecar logs: {}",
                startup_logs.join(" | ")
            )
        })?;
        port
    };

    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line_bytes) => {
                    println!("[sidecar] {}", String::from_utf8_lossy(&line_bytes));
                }
                CommandEvent::Stderr(line_bytes) => {
                    eprintln!("[sidecar] {}", String::from_utf8_lossy(&line_bytes));
                }
                _ => {}
            }
        }
    });

    let bootstrap = RuntimeBootstrap {
        api_base_url: format!("http://127.0.0.1:{resolved_port}/api"),
        auth_token,
        client_config,
        platform: std::env::consts::OS.to_string(),
    };

    Ok(AppState {
        bootstrap,
        sidecar: Mutex::new(Some(child)),
    })
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_geolocation::init())
        .setup(|app| {
            let app_state = tauri::async_runtime::block_on(start_sidecar(app.handle().clone()))?;
            app.manage(app_state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_runtime_bootstrap])
        .run(tauri::generate_context!())
        .expect("error while running TAC_VIEW desktop");
}
