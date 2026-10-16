mod files;
pub mod server;

#[cfg(feature = "desktop")]
mod desktop {
    use super::files::{FileStore, NativeFile, SaveResult};
    use super::server::{
        Asset, DocumentServer, ServerStatus, Snapshot, StartResult, UpdateRequest, UpdateResult,
    };
    use base64::{engine::general_purpose::STANDARD, Engine};
    use serde::Deserialize;
    use std::{
        path::PathBuf,
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc, Mutex,
        },
    };
    use tauri::{Emitter, Manager, State};
    use tauri_plugin_dialog::DialogExt;

    #[derive(Clone, Default)]
    pub struct NativeState(Arc<Mutex<FileStore>>);
    #[derive(Default)]
    pub struct Closing(AtomicBool);
    #[derive(Clone, Default)]
    pub struct ServerState(Arc<Mutex<DocumentServer>>);

    #[tauri::command]
    pub async fn start_document_server(
        document: serde_json::Value,
        app: tauri::AppHandle,
        state: State<'_, ServerState>,
    ) -> Result<StartResult, String> {
        let state = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            let resolver = app.asset_resolver();
            let embedded_paths: std::collections::HashSet<String> = resolver
                .iter()
                .map(|(name, _)| name.trim_start_matches('/').to_owned())
                .collect();
            let assets = Arc::new(move |path: &str| {
                if !embedded_paths.is_empty() && !embedded_paths.contains(path) {
                    return None;
                }
                resolver.get(path.to_owned()).map(|asset| Asset {
                    bytes: asset.bytes,
                    mime_type: asset.mime_type,
                })
            });
            state
                .0
                .lock()
                .map_err(|_| "共享服务状态不可用。")?
                .start(document, assets)
        })
        .await
        .map_err(|error| format!("启动共享服务失败：{error}"))?
    }
    #[tauri::command]
    pub async fn read_shared_document(
        session_id: String,
        state: State<'_, ServerState>,
    ) -> Result<Snapshot, String> {
        let state = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            state
                .0
                .lock()
                .map_err(|_| "共享服务状态不可用。")?
                .read(&session_id)
        })
        .await
        .map_err(|error| format!("读取共享内容失败：{error}"))?
    }
    #[tauri::command]
    pub async fn update_shared_document(
        session_id: String,
        base_revision: u64,
        document: serde_json::Value,
        state: State<'_, ServerState>,
    ) -> Result<UpdateResult, String> {
        let state = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            state
                .0
                .lock()
                .map_err(|_| "共享服务状态不可用。")?
                .update(UpdateRequest {
                    session_id,
                    base_revision,
                    document,
                })
        })
        .await
        .map_err(|error| format!("更新共享内容失败：{error}"))?
    }
    #[tauri::command]
    pub async fn stop_document_server(
        session_id: String,
        state: State<'_, ServerState>,
    ) -> Result<Option<Snapshot>, String> {
        let state = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            state
                .0
                .lock()
                .map_err(|_| "共享服务状态不可用。")?
                .stop(&session_id)
        })
        .await
        .map_err(|error| format!("停止共享服务失败：{error}"))?
    }
    #[tauri::command]
    pub fn document_server_status(state: State<'_, ServerState>) -> Result<ServerStatus, String> {
        Ok(state.0.lock().map_err(|_| "共享服务状态不可用。")?.status())
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct SaveRequest {
        suggested_name: String,
        bytes_base64: String,
        path: Option<String>,
        expected_stamp: Option<String>,
    }

    #[tauri::command]
    pub async fn open_native_files(
        app: tauri::AppHandle,
        state: State<'_, NativeState>,
    ) -> Result<Vec<NativeFile>, String> {
        let state = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            let mut store = state.0.lock().map_err(|_| "文件操作状态不可用。")?;
            let Some(selected) = app
                .dialog()
                .file()
                .add_filter(
                    "工作流和白板",
                    &[
                        "owflow",
                        "owf",
                        "json",
                        "drawio",
                        "xml",
                        "excalidraw",
                        "mmd",
                        "mermaid",
                        "txt",
                    ],
                )
                .blocking_pick_files()
            else {
                return Ok(Vec::new());
            };
            let paths = selected
                .into_iter()
                .map(|file| file.into_path().map_err(|_| "请选择本机文件。".to_string()))
                .collect::<Result<Vec<_>, _>>()?;
            store.open_files(paths)
        })
        .await
        .map_err(|error| format!("打开文件操作失败：{error}"))?
    }

    #[tauri::command]
    pub async fn save_native_file(
        request: SaveRequest,
        app: tauri::AppHandle,
        state: State<'_, NativeState>,
    ) -> Result<Option<SaveResult>, String> {
        if request.bytes_base64.len() > ((files_limit() + 2) / 3) * 4 {
            return Err("文件超过 50 MB 大小上限。".into());
        }
        let state = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            let bytes = STANDARD
                .decode(&request.bytes_base64)
                .map_err(|_| "文件内容编码无效。")?;
            let mut store = state.0.lock().map_err(|_| "文件操作状态不可用。")?;
            if let Some(path) = request.path {
                return store
                    .save_existing(
                        PathBuf::from(path),
                        request.expected_stamp.as_deref(),
                        &bytes,
                    )
                    .map(Some);
            }
            super::files::validate_suggested_name(&request.suggested_name)?;
            let Some(selected) = app
                .dialog()
                .file()
                .set_file_name(&request.suggested_name)
                .blocking_save_file()
            else {
                return Ok(None);
            };
            let mut path = selected.into_path().map_err(|_| "请选择本机保存位置。")?;
            if path.extension().is_none() {
                if let Some(extension) = std::path::Path::new(&request.suggested_name).extension() {
                    path.set_extension(extension);
                }
            }
            store.save_selected(path, &bytes).map(Some)
        })
        .await
        .map_err(|error| format!("保存文件操作失败：{error}"))?
    }

    fn files_limit() -> usize {
        super::files::FILE_LIMIT as usize
    }

    #[tauri::command]
    pub fn close_native_window(
        window: tauri::WebviewWindow,
        state: State<'_, Closing>,
    ) -> Result<(), String> {
        state.0.store(true, Ordering::Release);
        if let Err(error) = window.close() {
            state.0.store(false, Ordering::Release);
            return Err(format!("无法关闭窗口：{error}"));
        }
        Ok(())
    }

    pub fn run() {
        tauri::Builder::default()
            .plugin(tauri_plugin_dialog::init())
            .manage(NativeState::default())
            .manage(Closing::default())
            .manage(ServerState::default())
            .invoke_handler(tauri::generate_handler![
                open_native_files,
                save_native_file,
                close_native_window,
                start_document_server,
                read_shared_document,
                update_shared_document,
                stop_document_server,
                document_server_status
            ])
            .on_window_event(|window, event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    if !window.state::<Closing>().0.load(Ordering::Acquire) {
                        api.prevent_close();
                        let _ = window.emit("native-close-requested", ());
                    }
                }
            })
            .build(tauri::generate_context!())
            .expect("启动 Open Workflow 失败")
            .run(|app, event| {
                if matches!(event, tauri::RunEvent::Exit) {
                    let state = app.state::<ServerState>();
                    if let Ok(mut server) = state.0.lock() {
                        server.stop_all();
                    };
                }
            });
    }
}

#[cfg(feature = "desktop")]
pub use desktop::run;
