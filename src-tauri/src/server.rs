mod document;
#[cfg(test)]
mod tests;

use axum::{
    body::{to_bytes, Body},
    extract::{Request, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::any,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    future::IntoFuture,
    net::{IpAddr, Ipv4Addr, TcpListener},
    sync::{Arc, Mutex},
    thread::JoinHandle,
    time::Duration,
};
use tokio::sync::{oneshot, Semaphore};

pub struct Asset {
    pub bytes: Vec<u8>,
    pub mime_type: String,
}
pub type AssetProvider = Arc<dyn Fn(&str) -> Option<Asset> + Send + Sync>;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub session_id: String,
    pub revision: u64,
    pub document: Value,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    pub running: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    pub urls: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub document_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartResult {
    pub status: ServerStatus,
    pub snapshot: Snapshot,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateRequest {
    pub session_id: String,
    pub base_revision: u64,
    pub document: Value,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateResult {
    pub accepted: bool,
    pub snapshot: Snapshot,
}

struct SharedDocument {
    active: bool,
    snapshot: Snapshot,
}
#[derive(Clone)]
struct HttpState {
    shared: Arc<Mutex<SharedDocument>>,
    token: String,
    hosts: Arc<HashSet<String>>,
    assets: AssetProvider,
    permits: Arc<Semaphore>,
}
struct RunningServer {
    status: ServerStatus,
    shared: Arc<Mutex<SharedDocument>>,
    shutdown: Option<oneshot::Sender<()>>,
    worker: Option<JoinHandle<()>>,
}
#[derive(Default)]
pub struct DocumentServer {
    running: Option<RunningServer>,
}

fn random_id(bytes: usize) -> Result<String, String> {
    let mut random = vec![0; bytes];
    getrandom::fill(&mut random).map_err(|_| "无法获取安全的随机访问标识。")?;
    Ok(random.iter().map(|byte| format!("{byte:02x}")).collect())
}
pub fn local_addresses() -> Vec<Ipv4Addr> {
    let mut addresses: Vec<_> = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|interface| match interface.ip() {
            IpAddr::V4(ip)
                if !ip.is_loopback()
                    && !ip.is_unspecified()
                    && !ip.is_multicast()
                    && !ip.is_broadcast() =>
            {
                Some(ip)
            }
            _ => None,
        })
        .collect();
    addresses.sort_by_key(|ip| (!ip.is_private(), ip.octets()));
    addresses.dedup();
    addresses
}
impl DocumentServer {
    pub fn start(&mut self, document: Value, assets: AssetProvider) -> Result<StartResult, String> {
        if self.running.is_some() {
            return Err("服务已经运行，请先停止当前共享。".into());
        }
        let document = document::validate(document)?;
        if assets("index.html").is_none() {
            return Err("网页资源尚未构建，请先构建应用再启动共享。".into());
        }
        let token = random_id(32)?;
        let session_id = random_id(16)?;
        let listener = TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0))
            .map_err(|error| format!("无法启动局域网服务：{error}"))?;
        listener
            .set_nonblocking(true)
            .map_err(|error| format!("无法配置服务监听：{error}"))?;
        let port = listener
            .local_addr()
            .map_err(|_| "无法读取监听端口。")?
            .port();
        let addresses = local_addresses();
        let urls = addresses
            .iter()
            .map(|ip| format!("http://{ip}:{port}/#/share/{token}"))
            .collect();
        let status = ServerStatus {
            running: true,
            session_id: Some(session_id.clone()),
            port: Some(port),
            urls,
            local_url: Some(format!("http://127.0.0.1:{port}/#/share/{token}")),
            document_id: document
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_owned),
            title: document
                .get("title")
                .and_then(Value::as_str)
                .map(str::to_owned),
        };
        let snapshot = Snapshot {
            session_id,
            revision: 1,
            document,
        };
        let shared = Arc::new(Mutex::new(SharedDocument {
            active: true,
            snapshot: snapshot.clone(),
        }));
        let mut hosts: HashSet<String> =
            addresses.iter().map(|ip| format!("{ip}:{port}")).collect();
        hosts.insert(format!("127.0.0.1:{port}"));
        let http = HttpState {
            shared: shared.clone(),
            token,
            hosts: Arc::new(hosts),
            assets,
            permits: Arc::new(Semaphore::new(8)),
        };
        let (shutdown, stopped) = oneshot::channel();
        let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
        let worker = std::thread::Builder::new().name("document-server".into()).spawn(move || {
            let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
                Ok(runtime) => runtime,
                Err(error) => { let _ = ready_tx.send(Err(format!("无法创建共享服务运行环境：{error}"))); return; }
            };
            runtime.block_on(async move {
                let listener = match tokio::net::TcpListener::from_std(listener) {
                    Ok(listener) => listener,
                    Err(error) => { let _ = ready_tx.send(Err(format!("无法启动服务监听：{error}"))); return; }
                };
                let router = Router::new().fallback(any(handle)).with_state(http);
                let (graceful_tx, graceful_rx) = oneshot::channel::<()>();
                let server = axum::serve(listener, router).with_graceful_shutdown(async { let _ = graceful_rx.await; }).into_future();
                tokio::pin!(server);
                let _ = ready_tx.send(Ok(()));
                tokio::select! {
                    _ = &mut server => {},
                    _ = stopped => {
                        let _ = graceful_tx.send(());
                        let _ = tokio::time::timeout(Duration::from_millis(250), &mut server).await;
                    },
                }
            });
            runtime.shutdown_timeout(Duration::from_millis(100));
        }).map_err(|error| format!("无法创建共享服务线程：{error}"))?;
        if let Err(error) = ready_rx
            .recv()
            .map_err(|_| "服务启动未完成。".to_string())?
        {
            let _ = worker.join();
            return Err(error);
        }
        self.running = Some(RunningServer {
            status: status.clone(),
            shared,
            shutdown: Some(shutdown),
            worker: Some(worker),
        });
        Ok(StartResult { status, snapshot })
    }
    pub fn status(&self) -> ServerStatus {
        let Some(running) = &self.running else {
            return ServerStatus::default();
        };
        let mut status = running.status.clone();
        if let Ok(shared) = running.shared.lock() {
            status.title = shared
                .snapshot
                .document
                .get("title")
                .and_then(Value::as_str)
                .map(str::to_owned);
        }
        status
    }
    pub fn read(&self, session_id: &str) -> Result<Snapshot, String> {
        let running = self.running.as_ref().ok_or("共享服务未运行。")?;
        let shared = running.shared.lock().map_err(|_| "共享状态不可用。")?;
        if !shared.active || shared.snapshot.session_id != session_id {
            return Err("共享会话已结束或更换。".into());
        }
        Ok(shared.snapshot.clone())
    }
    pub fn update(&self, request: UpdateRequest) -> Result<UpdateResult, String> {
        let running = self.running.as_ref().ok_or("共享服务未运行。")?;
        update(&running.shared, request)
    }
    pub fn stop(&mut self, session_id: &str) -> Result<Option<Snapshot>, String> {
        let Some(running) = &self.running else {
            return Ok(None);
        };
        if running.status.session_id.as_deref() != Some(session_id) {
            return Err("共享会话已更换，不能停止新的共享。".into());
        }
        let snapshot = {
            let mut shared = running.shared.lock().map_err(|_| "共享状态不可用。")?;
            shared.active = false;
            shared.snapshot.clone()
        };
        self.stop_all();
        Ok(Some(snapshot))
    }
    pub fn stop_all(&mut self) {
        if let Some(mut running) = self.running.take() {
            if let Ok(mut shared) = running.shared.lock() {
                shared.active = false;
            }
            if let Some(shutdown) = running.shutdown.take() {
                let _ = shutdown.send(());
            }
            if let Some(worker) = running.worker.take() {
                let _ = worker.join();
            }
        }
    }
}
impl Drop for DocumentServer {
    fn drop(&mut self) {
        self.stop_all();
    }
}

fn update(shared: &Mutex<SharedDocument>, request: UpdateRequest) -> Result<UpdateResult, String> {
    let document = document::validate(request.document)?;
    let mut shared = shared.lock().map_err(|_| "共享状态不可用。")?;
    if !shared.active || shared.snapshot.session_id != request.session_id {
        return Err("共享会话已结束或更换。".into());
    }
    if document.get("id") != shared.snapshot.document.get("id")
        || document.get("kind") != shared.snapshot.document.get("kind")
    {
        return Err("共享期间不能替换文档 ID 或文档类型，请重新启动共享。".into());
    }
    if request.base_revision != shared.snapshot.revision {
        return Ok(UpdateResult {
            accepted: false,
            snapshot: shared.snapshot.clone(),
        });
    }
    let revision = shared
        .snapshot
        .revision
        .checked_add(1)
        .filter(|revision| *revision <= 9_007_199_254_740_991)
        .ok_or("修订序号已达上限，请重新启动共享。")?;
    shared.snapshot.revision = revision;
    shared.snapshot.document = document;
    Ok(UpdateResult {
        accepted: true,
        snapshot: shared.snapshot.clone(),
    })
}
fn error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}
fn authorized(headers: &HeaderMap, token: &str) -> bool {
    let Some(value) = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
    else {
        return false;
    };
    value.len() == token.len()
        && value
            .bytes()
            .zip(token.bytes())
            .fold(0_u8, |difference, (a, b)| difference | (a ^ b))
            == 0
}
fn safe_asset(path: &str) -> Option<&str> {
    if path == "/" {
        return Some("index.html");
    }
    if path == "/favicon.svg" {
        return Some("favicon.svg");
    }
    let name = path.strip_prefix("/assets/")?;
    if name.is_empty()
        || name.len() > 200
        || name.starts_with('.')
        || name.contains("..")
        || !name
            .bytes()
            .all(|ch| ch.is_ascii_alphanumeric() || b"._-".contains(&ch))
    {
        return None;
    }
    Some(path.trim_start_matches('/'))
}
fn secure(mut response: Response) -> Response {
    for (name, value) in [
        ("cache-control", "no-store"), ("referrer-policy", "no-referrer"), ("x-content-type-options", "nosniff"),
        ("x-frame-options", "DENY"), ("cross-origin-resource-policy", "same-origin"),
        ("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"),
    ] { response.headers_mut().insert(name, HeaderValue::from_static(value)); }
    response
}
async fn handle(State(state): State<HttpState>, request: Request) -> Response {
    secure(handle_request(state, request).await)
}
async fn handle_request(state: HttpState, request: Request) -> Response {
    let Ok(_permit) = state.permits.try_acquire() else {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "共享服务正在处理其他请求，请稍后重试。",
        );
    };
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if !state.hosts.contains(host) {
        return error(StatusCode::FORBIDDEN, "请使用软件显示的局域网访问地址。");
    }
    if let Some(origin) = request.headers().get(header::ORIGIN) {
        if origin.to_str().ok() != Some(format!("http://{host}").as_str()) {
            return error(StatusCode::FORBIDDEN, "不允许跨来源访问共享文档。");
        }
    }
    let path = request.uri().path();
    if path.len() > 512 || request.uri().query().is_some() {
        return error(StatusCode::NOT_FOUND, "请求地址不存在。");
    }
    if path == "/api/document" {
        if !authorized(request.headers(), &state.token) {
            return error(StatusCode::UNAUTHORIZED, "共享访问令牌无效或已经过期。");
        }
        if request.method() == Method::GET {
            if request.headers().contains_key(header::TRANSFER_ENCODING)
                || request
                    .headers()
                    .get(header::CONTENT_LENGTH)
                    .is_some_and(|value| value != "0")
            {
                return error(StatusCode::BAD_REQUEST, "读取请求不能包含请求正文。");
            }
            let Ok(shared) = state.shared.lock() else {
                return error(StatusCode::INTERNAL_SERVER_ERROR, "共享状态不可用。");
            };
            if !shared.active {
                return error(StatusCode::GONE, "共享会话已结束。");
            }
            return Json(shared.snapshot.clone()).into_response();
        }
        if request.method() != Method::PUT {
            return error(StatusCode::METHOD_NOT_ALLOWED, "该接口仅支持 GET 和 PUT。");
        }
        if request
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(';').next())
            .map(str::trim)
            != Some("application/json")
        {
            return error(StatusCode::UNSUPPORTED_MEDIA_TYPE, "请求正文应为 JSON。");
        }
        if request
            .headers()
            .get(header::CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<usize>().ok())
            .is_some_and(|size| size > document::DOCUMENT_LIMIT)
        {
            return error(StatusCode::PAYLOAD_TOO_LARGE, "请求正文超过 50 MB。");
        }
        let bytes = match tokio::time::timeout(
            Duration::from_secs(15),
            to_bytes(request.into_body(), document::DOCUMENT_LIMIT),
        )
        .await
        {
            Ok(Ok(bytes)) => bytes,
            Ok(Err(_)) => {
                return error(StatusCode::PAYLOAD_TOO_LARGE, "请求正文无效或超过 50 MB。")
            }
            Err(_) => return error(StatusCode::REQUEST_TIMEOUT, "接收共享修改超时，请重试。"),
        };
        let update_request = match serde_json::from_slice::<UpdateRequest>(&bytes) {
            Ok(request) => request,
            Err(_) => return error(StatusCode::BAD_REQUEST, "共享修改不是有效的请求数据。"),
        };
        return match update(&state.shared, update_request) {
            Ok(result) => (
                if result.accepted {
                    StatusCode::OK
                } else {
                    StatusCode::CONFLICT
                },
                Json(result),
            )
                .into_response(),
            Err(message) => error(StatusCode::BAD_REQUEST, &message),
        };
    }
    let Some(asset_path) = safe_asset(path) else {
        return error(StatusCode::NOT_FOUND, "请求地址不存在。");
    };
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return error(StatusCode::METHOD_NOT_ALLOWED, "网页资源仅支持读取。");
    }
    let Some(asset) = (state.assets)(asset_path) else {
        return error(StatusCode::NOT_FOUND, "网页资源不存在。");
    };
    let mime = match HeaderValue::from_str(&asset.mime_type) {
        Ok(mime) => mime,
        Err(_) => return error(StatusCode::INTERNAL_SERVER_ERROR, "网页资源类型无效。"),
    };
    let len = asset.bytes.len();
    let mut response = if request.method() == Method::HEAD {
        Body::empty()
    } else {
        Body::from(asset.bytes)
    }
    .into_response();
    response.headers_mut().insert(header::CONTENT_TYPE, mime);
    if let Ok(value) = HeaderValue::from_str(&len.to_string()) {
        response.headers_mut().insert(header::CONTENT_LENGTH, value);
    }
    response
}
