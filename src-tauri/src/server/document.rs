use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{Map, Value};
use std::collections::HashSet;
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

pub const DOCUMENT_LIMIT: usize = 50 * 1024 * 1024;
const SHAPES: &[&str] = &[
    "rectangle",
    "ellipse",
    "diamond",
    "note",
    "text",
    "image",
    "triangle",
    "hexagon",
    "star",
    "parallelogram",
    "cylinder",
    "cloud",
    "frame",
    "brace-left",
    "brace-right",
    "brace-top",
    "brace-bottom",
];
fn object(value: &Value) -> Result<&Map<String, Value>, String> {
    value.as_object().ok_or_else(|| "文档包含无效对象。".into())
}
fn text<'a>(value: Option<&'a Value>, limit: usize, field: &str) -> Result<&'a str, String> {
    let value = value
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{field}不是有效文本。"))?;
    if value.encode_utf16().count() > limit {
        return Err(format!("{field}超过长度限制。"));
    }
    Ok(value)
}
fn number(value: Option<&Value>, min: f64, max: f64, field: &str) -> Result<f64, String> {
    let value = value
        .and_then(Value::as_f64)
        .ok_or_else(|| format!("{field}不是有效数值。"))?;
    if !value.is_finite() || value < min || value > max {
        return Err(format!("{field}超出有效范围。"));
    }
    Ok(value)
}
fn choice<'a>(value: Option<&'a Value>, allowed: &[&str], field: &str) -> Result<&'a str, String> {
    let value = text(value, 100, field)?;
    if !allowed.contains(&value) {
        return Err(format!("{field}不受支持。"));
    }
    Ok(value)
}
fn boolean(value: Option<&Value>, field: &str) -> Result<(), String> {
    if value.is_some_and(|value| !value.is_boolean()) {
        return Err(format!("{field}不是有效布尔值。"));
    }
    Ok(())
}
fn color(value: Option<&Value>) -> Result<(), String> {
    let value = text(value, 128, "颜色")?.to_ascii_lowercase();
    let valid = if let Some(hex) = value.strip_prefix('#') {
        [3, 4, 6, 8].contains(&hex.len()) && hex.bytes().all(|ch| ch.is_ascii_hexdigit())
    } else if [
        "transparent",
        "none",
        "black",
        "white",
        "red",
        "blue",
        "green",
        "yellow",
        "orange",
        "purple",
        "gray",
        "grey",
        "pink",
        "cyan",
        "magenta",
        "navy",
        "teal",
        "lime",
        "maroon",
        "olive",
        "silver",
        "aqua",
        "fuchsia",
        "rebeccapurple",
    ]
    .contains(&value.as_str())
    {
        true
    } else {
        ["rgb(", "rgba(", "hsl(", "hsla("].iter().any(|prefix| {
            value
                .strip_prefix(prefix)
                .and_then(|body| body.strip_suffix(')'))
                .is_some_and(|body| {
                    !body.is_empty()
                        && body
                            .bytes()
                            .all(|ch| ch.is_ascii_digit() || b".,% /".contains(&ch))
                })
        })
    };
    if !valid {
        return Err("颜色包含不支持的格式。".into());
    }
    Ok(())
}
fn style(value: Option<&Value>) -> Result<(), String> {
    let Some(value) = value else {
        return Ok(());
    };
    let map = object(value)?;
    color(map.get("stroke"))?;
    color(map.get("fill"))?;
    number(map.get("strokeWidth"), 0., 100., "线宽")?;
    number(map.get("fontSize"), 1., 500., "字号")?;
    number(map.get("opacity"), 0., 1., "透明度")?;
    choice(
        map.get("textAlign"),
        &["left", "center", "right"],
        "文字对齐",
    )?;
    boolean(map.get("dashed"), "虚线状态")?;
    if map.contains_key("roughness") {
        choice(map.get("roughness"), &["clean", "sketch"], "线条外观")?;
    }
    if map.contains_key("strokePattern") {
        choice(
            map.get("strokePattern"),
            &["solid", "dashed", "dotted"],
            "线型",
        )?;
    }
    Ok(())
}
fn point(value: &Value) -> Result<(), String> {
    let map = object(value)?;
    number(map.get("x"), -1_000_000., 1_000_000., "X")?;
    number(map.get("y"), -1_000_000., 1_000_000., "Y")?;
    Ok(())
}
fn image(value: Option<&Value>) -> Result<(), String> {
    let value = text(value, 14 * 1024 * 1024, "图片")?;
    let body = [
        "data:image/png;base64,",
        "data:image/jpeg;base64,",
        "data:image/webp;base64,",
    ]
    .iter()
    .find_map(|prefix| value.strip_prefix(prefix))
    .ok_or("图片必须为内嵌 PNG、JPEG 或 WebP。")?;
    let body: String = body
        .chars()
        .filter(|ch| *ch != '\r' && *ch != '\n')
        .collect();
    let bytes = STANDARD.decode(body).map_err(|_| "图片编码无效。")?;
    if bytes.len() > 10 * 1024 * 1024 {
        return Err("单张图片不能超过 10 MB。".into());
    }
    Ok(())
}

fn retain_fields(value: &mut Value, fields: &[&str]) {
    if let Some(object) = value.as_object_mut() {
        object.retain(|key, _| fields.contains(&key.as_str()));
    }
}
fn clean_style(value: &mut Value) {
    retain_fields(
        value,
        &[
            "stroke",
            "fill",
            "strokeWidth",
            "fontSize",
            "opacity",
            "textAlign",
            "dashed",
            "roughness",
            "strokePattern",
        ],
    );
}
fn clean_scene(value: &mut Value) {
    retain_fields(value, &["background", "grid", "defaultStyle", "elements"]);
    if let Some(style) = value.get_mut("defaultStyle") {
        clean_style(style);
    }
    if let Some(elements) = value.get_mut("elements").and_then(Value::as_array_mut) {
        for element in elements {
            let fields = match element.get("type").and_then(Value::as_str) {
                Some("shape") => &[
                    "id",
                    "type",
                    "shape",
                    "x",
                    "y",
                    "width",
                    "height",
                    "text",
                    "imageData",
                    "style",
                    "locked",
                    "groupId",
                ][..],
                Some("edge") => &[
                    "id", "type", "from", "to", "label", "arrow", "route", "style", "locked",
                    "groupId",
                ][..],
                _ => &[
                    "id",
                    "type",
                    "points",
                    "brush",
                    "pressures",
                    "closed",
                    "style",
                    "locked",
                    "groupId",
                ][..],
            };
            retain_fields(element, fields);
            if element.get("shape").and_then(Value::as_str) != Some("image") {
                element.as_object_mut().unwrap().remove("imageData");
            }
            if let Some(style) = element.get_mut("style") {
                clean_style(style);
            }
            for side in ["from", "to"] {
                if let Some(point) = element.get_mut(side) {
                    retain_fields(point, &["x", "y", "nodeId"]);
                }
            }
            if let Some(points) = element.get_mut("points").and_then(Value::as_array_mut) {
                for point in points {
                    retain_fields(point, &["x", "y"]);
                }
            }
        }
    }
}

/// Shared content has the native schema but never carries original imports or local metadata.
pub fn validate(mut document: Value) -> Result<Value, String> {
    let root = document.as_object_mut().ok_or("共享文档不是有效对象。")?;
    root.retain(|key, _| {
        [
            "format",
            "version",
            "id",
            "title",
            "kind",
            "scene",
            "source",
            "diagramStyle",
            "createdAt",
            "updatedAt",
        ]
        .contains(&key.as_str())
    });
    if root.get("format").and_then(Value::as_str) != Some("open-workflow")
        || root.get("version").and_then(Value::as_u64) != Some(1)
    {
        return Err("共享文档格式或版本不受支持。".into());
    }
    if text(root.get("id"), 512, "文档 ID")?.is_empty() {
        return Err("文档 ID 不能为空。".into());
    }
    text(root.get("title"), 200, "标题")?;
    choice(root.get("kind"), &["flow", "board", "mermaid"], "文档类型")?;
    text(root.get("source"), 500_000, "图表源码")?;
    if root.contains_key("diagramStyle") {
        choice(
            root.get("diagramStyle"),
            &[
                "classic",
                "minimal",
                "blueprint",
                "ink",
                "sketch",
                "forest",
                "ocean",
                "sunset",
                "lavender",
                "midnight",
            ],
            "绘图风格",
        )?;
    }
    for field in ["createdAt", "updatedAt"] {
        let value = text(root.get(field), 64, field)?;
        OffsetDateTime::parse(value, &Rfc3339).map_err(|_| "文档时间无效。")?;
    }
    let scene = object(root.get("scene").ok_or("缺少画布内容。")?)?;
    color(scene.get("background"))?;
    boolean(scene.get("grid"), "网格状态")?;
    style(scene.get("defaultStyle"))?;
    let elements = scene
        .get("elements")
        .and_then(Value::as_array)
        .ok_or("画布元素不是数组。")?;
    if elements.len() > 5000 {
        return Err("画布最多支持 5000 个元素。".into());
    }
    let mut ids = HashSet::new();
    let mut shape_ids = HashSet::new();
    let mut references = Vec::new();
    let mut count = 0;
    for element in elements {
        let e = object(element)?;
        let id = text(e.get("id"), 512, "元素 ID")?;
        if id.is_empty() || !ids.insert(id) {
            return Err("元素 ID 为空或重复。".into());
        }
        style(e.get("style"))?;
        boolean(e.get("locked"), "锁定状态")?;
        if e.contains_key("groupId") {
            text(e.get("groupId"), 512, "组合 ID")?;
        }
        match choice(e.get("type"), &["shape", "edge", "stroke"], "元素类型")? {
            "shape" => {
                shape_ids.insert(id);
                let kind = choice(e.get("shape"), SHAPES, "图形")?;
                point(element)?;
                number(e.get("width"), 1., 100_000., "宽度")?;
                number(e.get("height"), 1., 100_000., "高度")?;
                text(e.get("text"), 100_000, "图形文本")?;
                if kind == "image" {
                    image(e.get("imageData"))?;
                }
            }
            "edge" => {
                for side in ["from", "to"] {
                    let endpoint = e.get(side).ok_or("连线缺少端点。")?;
                    point(endpoint)?;
                    if let Some(node_id) = endpoint.get("nodeId") {
                        references.push(text(Some(node_id), 512, "绑定元素 ID")?);
                    }
                }
                text(e.get("label"), 100_000, "连线标签")?;
                choice(e.get("arrow"), &["none", "end", "both"], "箭头")?;
                choice(e.get("route"), &["straight", "orthogonal"], "连线路由")?;
            }
            "stroke" => {
                let points = e
                    .get("points")
                    .and_then(Value::as_array)
                    .ok_or("笔迹坐标不是数组。")?;
                boolean(e.get("closed"), "闭合状态")?;
                if points.len()
                    < if e.get("closed").and_then(Value::as_bool) == Some(true) {
                        3
                    } else {
                        1
                    }
                {
                    return Err("笔迹坐标不足。".into());
                }
                count += points.len();
                if count > 100_000 {
                    return Err("笔迹总点数超过 100000。".into());
                }
                for p in points {
                    point(p)?;
                }
                if e.contains_key("brush") {
                    choice(
                        e.get("brush"),
                        &["pen", "pencil", "marker", "brush", "highlighter", "rainbow"],
                        "笔触",
                    )?;
                }
                if let Some(pressures) = e.get("pressures") {
                    let pressures = pressures.as_array().ok_or("笔迹压感不是数组。")?;
                    if pressures.len() != points.len() {
                        return Err("笔迹压感与坐标数量不一致。".into());
                    }
                    for pressure in pressures {
                        number(Some(pressure), 0., 1., "压感")?;
                    }
                }
            }
            _ => unreachable!(),
        }
    }
    if references.iter().any(|id| !shape_ids.contains(id)) {
        return Err("连线引用了不存在的图形。".into());
    }
    clean_scene(document.get_mut("scene").unwrap());
    if serde_json::to_vec(&document)
        .map_err(|_| "文档编码失败。")?
        .len()
        > DOCUMENT_LIMIT
    {
        return Err("共享文档超过 50 MB。".into());
    }
    Ok(document)
}
