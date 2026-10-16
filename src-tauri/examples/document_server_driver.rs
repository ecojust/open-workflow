//! Line-based command transport for exercising the real document service without a window.
use open_workflow_lib::server::{Asset, AssetProvider, DocumentServer, UpdateRequest};
use serde_json::{json, Value};
use std::{
    io::{self, BufRead, Write},
    path::PathBuf,
    sync::Arc,
};

fn main() {
    let root = PathBuf::from(
        std::env::args()
            .nth(1)
            .expect("Pass the built web directory"),
    )
    .canonicalize()
    .expect("Built web directory must exist");
    let assets: AssetProvider = Arc::new(move |name| {
        let path = root.join(name).canonicalize().ok()?;
        if !path.starts_with(&root) || !path.is_file() {
            return None;
        }
        let mime_type = match path.extension().and_then(|extension| extension.to_str()) {
            Some("html") => "text/html; charset=utf-8",
            Some("js") => "text/javascript; charset=utf-8",
            Some("css") => "text/css; charset=utf-8",
            Some("svg") => "image/svg+xml",
            Some("png") => "image/png",
            Some("woff2") => "font/woff2",
            Some("json") => "application/json",
            _ => "application/octet-stream",
        }
        .to_string();
        Some(Asset {
            bytes: std::fs::read(path).ok()?,
            mime_type,
        })
    });
    let mut service = DocumentServer::default();
    for line in io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let request: Value = match serde_json::from_str(&line) {
            Ok(request) => request,
            Err(error) => {
                eprintln!("Invalid command: {error}");
                continue;
            }
        };
        let args = &request["args"];
        let session = args["sessionId"].as_str().unwrap_or_default();
        let result: Result<Value, String> = match request["command"].as_str().unwrap_or_default() {
            "start_document_server" => service
                .start(args["document"].clone(), assets.clone())
                .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string())),
            "document_server_status" => {
                serde_json::to_value(service.status()).map_err(|error| error.to_string())
            }
            "read_shared_document" => service
                .read(session)
                .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string())),
            "update_shared_document" => serde_json::from_value::<UpdateRequest>(args.clone())
                .map_err(|error| error.to_string())
                .and_then(|request| service.update(request))
                .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string())),
            "stop_document_server" => service
                .stop(session)
                .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string())),
            _ => Err("Unknown service command".to_string()),
        };
        let reply = match result {
            Ok(result) => json!({ "id": request["id"], "result": result }),
            Err(error) => json!({ "id": request["id"], "error": error }),
        };
        println!("{reply}");
        io::stdout().flush().expect("Cannot flush command response");
    }
    service.stop_all();
}
