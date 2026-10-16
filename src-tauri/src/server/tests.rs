use super::*;
use std::{
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    time::Instant,
};

fn example_document() -> Value {
    json!({ "format": "open-workflow", "version": 1, "id": "document-a", "title": "共享画布", "kind": "board", "source": "", "createdAt": "2026-10-16T12:00:00.000Z", "updatedAt": "2026-10-16T12:00:00.000Z", "scene": { "background": "#ffffff", "grid": true, "elements": [] } })
}
fn assets() -> AssetProvider {
    Arc::new(|path| match path {
        "index.html" => Some(Asset {
            bytes: b"<!doctype html><title>Shared canvas</title>".to_vec(),
            mime_type: "text/html; charset=utf-8".into(),
        }),
        "assets/app-test.js" => Some(Asset {
            bytes: b"export const ready = true;".to_vec(),
            mime_type: "text/javascript".into(),
        }),
        _ => None,
    })
}
fn token(start: &StartResult) -> &str {
    start
        .status
        .local_url
        .as_deref()
        .unwrap()
        .split("/#/share/")
        .nth(1)
        .unwrap()
}
fn request(
    port: u16,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: &[u8],
) -> (u16, String, Vec<u8>) {
    let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    stream
        .set_write_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let mut head = format!("{method} {path} HTTP/1.1\r\nConnection: close\r\n");
    if !headers
        .iter()
        .any(|(name, _)| name.eq_ignore_ascii_case("host"))
    {
        head.push_str(&format!("Host: 127.0.0.1:{port}\r\n"));
    }
    if !headers
        .iter()
        .any(|(name, _)| name.eq_ignore_ascii_case("content-length"))
    {
        head.push_str(&format!("Content-Length: {}\r\n", body.len()));
    }
    for (name, value) in headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes()).unwrap();
    stream.write_all(body).unwrap();
    let mut result = Vec::new();
    stream.read_to_end(&mut result).unwrap();
    let split = result
        .windows(4)
        .position(|part| part == b"\r\n\r\n")
        .unwrap();
    let head = String::from_utf8(result[..split].to_vec()).unwrap();
    let code = head.split_whitespace().nth(1).unwrap().parse().unwrap();
    (code, head, result[split + 4..].to_vec())
}
fn get(start: &StartResult) -> (u16, Value) {
    let auth = format!("Bearer {}", token(start));
    let (code, _, body) = request(
        start.status.port.unwrap(),
        "GET",
        "/api/document",
        &[("Authorization", &auth)],
        &[],
    );
    (code, serde_json::from_slice(&body).unwrap())
}
fn put(start: &StartResult, revision: u64, document: Value) -> (u16, Value) {
    let auth = format!("Bearer {}", token(start));
    let body = serde_json::to_vec(&json!({ "sessionId": start.snapshot.session_id, "baseRevision": revision, "document": document })).unwrap();
    let (code, _, body) = request(
        start.status.port.unwrap(),
        "PUT",
        "/api/document",
        &[
            ("Authorization", &auth),
            ("Content-Type", "application/json"),
        ],
        &body,
    );
    (code, serde_json::from_slice(&body).unwrap())
}
fn port_is_closed(port: u16) -> bool {
    TcpStream::connect_timeout(
        &SocketAddr::from((Ipv4Addr::LOCALHOST, port)),
        Duration::from_millis(300),
    )
    .is_err()
}

#[test]
fn service_starts_explicitly_and_serves_only_app_assets() {
    let mut service = DocumentServer::default();
    assert!(!service.status().running);
    assert!(service.stop("missing").unwrap().is_none());
    assert!(service
        .start(example_document(), Arc::new(|_| None))
        .is_err());
    let start = service.start(example_document(), assets()).unwrap();
    assert!(start.status.running);
    assert_eq!(start.snapshot.revision, 1);
    assert_eq!(token(&start).len(), 64);
    assert_ne!(start.snapshot.session_id, token(&start));
    assert!(start
        .status
        .urls
        .iter()
        .all(|url| url.ends_with(token(&start))));
    assert!(service.start(example_document(), assets()).is_err());
    let port = start.status.port.unwrap();
    for path in ["/", "/assets/app-test.js"] {
        let (code, headers, body) = request(port, "GET", path, &[], &[]);
        assert_eq!(code, 200);
        assert!(!body.is_empty());
        assert!(headers.contains("cache-control: no-store"));
        assert!(headers.contains("referrer-policy: no-referrer"));
        assert!(headers.contains("frame-ancestors 'none'"));
        let (code, _, body) = request(port, "HEAD", path, &[], &[]);
        assert_eq!(code, 200);
        assert!(body.is_empty());
    }
    for path in [
        "/index.html",
        "/secret.txt",
        "/assets/../index.html",
        "/assets/%2e%2e",
        "/assets/folder/app.js",
        "/assets/.hidden",
        "/assets/missing.js",
        "/?document=other",
        "/api/document?token=x",
    ] {
        assert_eq!(request(port, "GET", path, &[], &[]).0, 404, "{path}");
    }
    assert_eq!(request(port, "POST", "/", &[], &[]).0, 405);
}

#[test]
fn network_authentication_host_origin_and_request_limits_are_enforced() {
    let mut service = DocumentServer::default();
    let start = service.start(example_document(), assets()).unwrap();
    let port = start.status.port.unwrap();
    let auth = format!("Bearer {}", token(&start));
    assert_eq!(request(port, "GET", "/api/document", &[], &[]).0, 401);
    assert_eq!(
        request(
            port,
            "GET",
            "/api/document",
            &[("Authorization", "Bearer wrong")],
            &[]
        )
        .0,
        401
    );
    assert_eq!(
        request(
            port,
            "GET",
            "/api/document",
            &[("Authorization", &auth), ("Host", "attacker.invalid")],
            &[]
        )
        .0,
        403
    );
    assert_eq!(
        request(
            port,
            "GET",
            "/api/document",
            &[
                ("Authorization", &auth),
                ("Origin", "http://elsewhere.invalid")
            ],
            &[]
        )
        .0,
        403
    );
    assert_eq!(
        request(
            port,
            "GET",
            "/api/document",
            &[("Authorization", &auth), ("Origin", "null")],
            &[]
        )
        .0,
        403
    );
    assert_eq!(
        request(
            port,
            "GET",
            "/api/document",
            &[
                ("Authorization", &auth),
                ("Origin", &format!("http://127.0.0.1:{port}"))
            ],
            &[]
        )
        .0,
        200
    );
    assert_eq!(
        request(
            port,
            "GET",
            "/api/document",
            &[("Authorization", &auth)],
            b"x"
        )
        .0,
        400
    );
    assert_eq!(
        request(
            port,
            "DELETE",
            "/api/document",
            &[("Authorization", &auth)],
            &[]
        )
        .0,
        405
    );
    assert_eq!(
        request(
            port,
            "PUT",
            "/api/document",
            &[("Authorization", &auth)],
            b"{}"
        )
        .0,
        415
    );
    assert_eq!(
        request(
            port,
            "PUT",
            "/api/document",
            &[
                ("Authorization", &auth),
                ("Content-Type", "application/json")
            ],
            b"not-json"
        )
        .0,
        400
    );
    assert_eq!(
        request(
            port,
            "PUT",
            "/api/document",
            &[
                ("Authorization", &auth),
                ("Content-Type", "application/json"),
                ("Content-Length", "52428801")
            ],
            &[]
        )
        .0,
        413
    );
}

#[test]
fn http_updates_and_native_updates_share_atomic_revisions() {
    let mut document = example_document();
    document["importSource"] = json!({ "text": "private original", "name": "/private/a.xml" });
    document["path"] = json!("/private/a.owflow");
    let mut service = DocumentServer::default();
    let start = service.start(document, assets()).unwrap();
    let (code, snapshot) = get(&start);
    assert_eq!(code, 200);
    assert_eq!(snapshot["revision"], 1);
    assert!(snapshot["document"].get("path").is_none());
    assert!(snapshot["document"].get("importSource").is_none());
    assert!(!snapshot.to_string().contains(token(&start)));
    let mut updated = start.snapshot.document.clone();
    updated["title"] = json!("网页更新");
    let (code, result) = put(&start, 1, updated.clone());
    assert_eq!(code, 200);
    assert_eq!(result["accepted"], true);
    assert_eq!(result["snapshot"]["revision"], 2);
    assert_eq!(
        service.read(&start.snapshot.session_id).unwrap().document,
        updated
    );
    assert_eq!(service.status().title.as_deref(), Some("网页更新"));
    updated["title"] = json!("过期更新");
    let (code, result) = put(&start, 1, updated.clone());
    assert_eq!(code, 409);
    assert_eq!(result["accepted"], false);
    assert_eq!(result["snapshot"]["document"]["title"], "网页更新");
    updated["title"] = json!("桌面更新");
    let result = service
        .update(UpdateRequest {
            session_id: start.snapshot.session_id.clone(),
            base_revision: 2,
            document: updated.clone(),
        })
        .unwrap();
    assert!(result.accepted);
    assert_eq!(result.snapshot.revision, 3);
    assert_eq!(get(&start).1["document"], updated);
}

#[test]
fn simultaneous_network_edits_accept_exactly_one_revision() {
    let mut service = DocumentServer::default();
    let start = Arc::new(service.start(example_document(), assets()).unwrap());
    let barrier = Arc::new(std::sync::Barrier::new(3));
    let threads: Vec<_> = (0..2)
        .map(|index| {
            let start = start.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let mut document = start.snapshot.document.clone();
                document["title"] = json!(format!("client-{index}"));
                barrier.wait();
                put(&start, 1, document)
            })
        })
        .collect();
    barrier.wait();
    let mut codes: Vec<_> = threads
        .into_iter()
        .map(|thread| thread.join().unwrap().0)
        .collect();
    codes.sort();
    assert_eq!(codes, vec![200, 409]);
    assert_eq!(
        service.read(&start.snapshot.session_id).unwrap().revision,
        2
    );
}

#[test]
fn network_round_trip_preserves_fractional_coordinates_exactly() {
    let mut service = DocumentServer::default();
    let start = service.start(example_document(), assets()).unwrap();
    let mut document = example_document();
    let x = 242.39999389648438_f64;
    let width = 218.16000366210938_f64;
    document["scene"]["elements"] = json!([{ "id": "fractional", "type": "shape", "shape": "rectangle", "x": x, "y": -0.000003141592653589793_f64, "width": width, "height": 113.62000274658203_f64, "text": "精确位置" }]);
    let (code, result) = put(&start, 1, document.clone());
    assert_eq!(code, 200);
    assert_eq!(result["accepted"], true);
    let saved = service.read(&start.snapshot.session_id).unwrap();
    assert_eq!(
        saved.document["scene"]["elements"][0]["x"]
            .as_f64()
            .unwrap()
            .to_bits(),
        x.to_bits()
    );
    assert_eq!(
        saved.document["scene"]["elements"][0]["width"]
            .as_f64()
            .unwrap()
            .to_bits(),
        width.to_bits()
    );
    assert_eq!(result["snapshot"]["document"], document);
    assert_eq!(get(&start).1["document"], document);
}

#[test]
fn native_and_network_clients_cannot_replace_the_shared_document() {
    let mut service = DocumentServer::default();
    let start = service.start(example_document(), assets()).unwrap();
    for (field, value) in [("id", "another"), ("kind", "flow")] {
        let mut changed = example_document();
        changed[field] = json!(value);
        assert_eq!(put(&start, 1, changed).0, 400);
    }
    assert!(service
        .update(UpdateRequest {
            session_id: "old-session".into(),
            base_revision: 1,
            document: example_document()
        })
        .is_err());
    assert!(service.read("old-session").is_err());
    assert_eq!(
        service.read(&start.snapshot.session_id).unwrap().revision,
        1
    );
}

#[test]
fn stop_captures_the_final_accepted_edit_and_revokes_inflight_writes() {
    let mut service = DocumentServer::default();
    let start = service.start(example_document(), assets()).unwrap();
    let shared = service.running.as_ref().unwrap().shared.clone();
    let mut document = example_document();
    document["title"] = json!("最后一次网页修改");
    assert_eq!(put(&start, 1, document.clone()).0, 200);
    let final_snapshot = service.stop(&start.snapshot.session_id).unwrap().unwrap();
    assert_eq!(final_snapshot.revision, 2);
    assert_eq!(final_snapshot.document, document);
    assert!(update(
        &shared,
        UpdateRequest {
            session_id: start.snapshot.session_id.clone(),
            base_revision: 2,
            document: example_document()
        }
    )
    .is_err());
    assert!(port_is_closed(start.status.port.unwrap()));
    assert!(!service.status().running);
    assert!(service.stop(&start.snapshot.session_id).unwrap().is_none());
    let next = service.start(example_document(), assets()).unwrap();
    assert_ne!(token(&start), token(&next));
    assert_ne!(start.snapshot.session_id, next.snapshot.session_id);
    assert!(service.stop(&start.snapshot.session_id).is_err());
    assert!(service.status().running);
    let old_auth = format!("Bearer {}", token(&start));
    assert_eq!(
        request(
            next.status.port.unwrap(),
            "GET",
            "/api/document",
            &[("Authorization", &old_auth)],
            &[]
        )
        .0,
        401
    );
}

#[test]
fn stop_and_drop_release_listener_even_with_a_partial_request() {
    let mut service = DocumentServer::default();
    let start = service.start(example_document(), assets()).unwrap();
    let mut stalled =
        TcpStream::connect((Ipv4Addr::LOCALHOST, start.status.port.unwrap())).unwrap();
    write!(stalled, "PUT /api/document HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{{", start.status.port.unwrap(), token(&start)).unwrap();
    let before = Instant::now();
    service.stop(&start.snapshot.session_id).unwrap();
    assert!(before.elapsed() < Duration::from_secs(2));
    assert!(port_is_closed(start.status.port.unwrap()));
    let start = service.start(example_document(), assets()).unwrap();
    drop(service);
    assert!(port_is_closed(start.status.port.unwrap()));
}

#[test]
fn invalid_diagram_source_can_be_shared_for_editing() {
    let mut document = example_document();
    document["kind"] = json!("mermaid");
    document["source"] = json!("flowchart LR\n incomplete ->[");
    let mut service = DocumentServer::default();
    let start = service.start(document.clone(), assets()).unwrap();
    assert_eq!(get(&start).1["document"], document);
}

#[test]
fn validator_preserves_native_brushes_and_strips_nested_local_metadata() {
    let mut document = example_document();
    document["scene"]["path"] = json!("/private/file");
    document["scene"]["elements"] = json!([{ "id": "s", "type": "shape", "shape": "rectangle", "x": 0, "y": 0, "width": 120, "height": 90, "text": "节点", "path": "/private/shape", "imageData": "hidden metadata" }, { "id": "e", "type": "edge", "from": { "x": 10, "y": 10, "nodeId": "s", "path": "/private/from" }, "to": { "x": 200, "y": 100 }, "label": "", "arrow": "end", "route": "orthogonal" }, { "id": "p", "type": "stroke", "brush": "rainbow", "points": [{ "x": 1, "y": 2, "path": "/private/point" }, { "x": 3, "y": 5 }], "pressures": [0.1, 0.9] }]);
    let clean = document::validate(document).unwrap();
    assert!(!clean.to_string().contains("private"));
    assert!(!clean.to_string().contains("hidden metadata"));
    assert_eq!(clean["scene"]["elements"][2]["brush"], "rainbow");
    assert_eq!(
        clean["scene"]["elements"][2]["pressures"],
        json!([0.1, 0.9])
    );
    assert_eq!(document::validate(clean.clone()).unwrap(), clean);
}

#[test]
fn validator_rejects_invalid_geometry_bindings_brushes_and_external_images() {
    let base = json!({ "id": "s", "type": "shape", "shape": "rectangle", "x": 0, "y": 0, "width": 120, "height": 90, "text": "节点" });
    for (field, value) in [
        ("x", json!(1_000_001)),
        ("width", json!(-1)),
        ("shape", json!("unsupported")),
        ("locked", json!("yes")),
    ] {
        let mut element = base.clone();
        element[field] = value;
        let mut document = example_document();
        document["scene"]["elements"] = json!([element]);
        assert!(document::validate(document).is_err(), "{field}");
    }
    let mut document = example_document();
    document["scene"]["elements"] = json!([base.clone(), base]);
    assert!(document::validate(document).is_err());
    for element in [
        json!({ "id": "e", "type": "edge", "from": { "x": 1, "y": 1, "nodeId": "missing" }, "to": { "x": 2, "y": 2 }, "label": "", "arrow": "end", "route": "orthogonal" }),
        json!({ "id": "p", "type": "stroke", "points": [{ "x": 1, "y": 1 }], "pressures": [] }),
        json!({ "id": "p", "type": "stroke", "points": [{ "x": 1, "y": 1 }], "pressures": [2] }),
        json!({ "id": "p", "type": "stroke", "points": [{ "x": 1, "y": 1 }], "closed": true }),
        json!({ "id": "i", "type": "shape", "shape": "image", "x": 0, "y": 0, "width": 2, "height": 2, "text": "", "imageData": "http://remote/image.png" }),
    ] {
        let mut document = example_document();
        document["scene"]["elements"] = json!([element]);
        assert!(document::validate(document).is_err());
    }
}

#[test]
fn validator_enforces_text_element_and_total_point_limits() {
    let mut document = example_document();
    document["title"] = json!("🌱".repeat(101));
    assert!(document::validate(document).is_err());
    let mut document = example_document();
    document["source"] = json!("a".repeat(500_001));
    assert!(document::validate(document).is_err());
    let mut document = example_document();
    document["scene"]["elements"] = Value::Array((0..5001).map(|id| json!({ "id": id.to_string(), "type": "stroke", "points": [{ "x": 1, "y": 1 }] })).collect());
    assert!(document::validate(document).is_err());
    let mut document = example_document();
    document["scene"]["elements"] = json!([{ "id": "p", "type": "stroke", "points": vec![json!({ "x": 1, "y": 1 }); 100_001] }]);
    assert!(document::validate(document.clone()).is_err());
    document["scene"]["elements"][0]["points"]
        .as_array_mut()
        .unwrap()
        .pop();
    assert!(document::validate(document).is_ok());
}
