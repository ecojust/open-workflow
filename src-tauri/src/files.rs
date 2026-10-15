use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, File, Permissions},
    io::{Read, Write},
    path::{Path, PathBuf},
};
use tempfile::NamedTempFile;

pub const FILE_LIMIT: u64 = 50 * 1024 * 1024;
const BATCH_LIMIT: usize = 100 * 1024 * 1024;
const MAX_OPEN_FILES: usize = 16;

#[derive(Debug, Serialize)]
pub struct NativeFile {
    pub name: String,
    pub path: String,
    pub text: String,
    pub stamp: String,
}
#[derive(Debug, Serialize)]
pub struct SaveResult {
    pub name: String,
    pub path: String,
    pub stamp: String,
}

/// Paths enter this store only after an operating-system file dialog succeeds.
#[derive(Default)]
pub struct FileStore {
    grants: HashMap<PathBuf, String>,
}

fn stamp(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn path_string(path: &Path) -> Result<String, String> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| "文件路径无法转换为 Unicode。".into())
}
fn name(path: &Path) -> Result<String, String> {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(str::to_owned)
        .ok_or_else(|| "文件名无效。".into())
}
pub fn validate_suggested_name(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 240
        || value == "."
        || value == ".."
        || value
            .chars()
            .any(|c| c.is_control() || "/\\:*?\"<>|".contains(c))
    {
        return Err("请使用有效文件名，不要包含路径或特殊字符。".into());
    }
    Ok(())
}
fn read_bytes(path: &Path) -> Result<Vec<u8>, String> {
    let file = File::open(path).map_err(|error| format!("无法读取文件：{error}"))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("无法读取文件信息：{error}"))?;
    if !metadata.is_file() {
        return Err("请选择普通文件。".into());
    }
    if metadata.len() > FILE_LIMIT {
        return Err("文件超过 50 MB 大小上限。".into());
    }
    let mut bytes = Vec::new();
    file.take(FILE_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("文件读取失败：{error}"))?;
    if bytes.len() as u64 > FILE_LIMIT {
        return Err("文件超过 50 MB 大小上限。".into());
    }
    Ok(bytes)
}

struct Snapshot {
    path: PathBuf,
    stamp: Option<String>,
    permissions: Option<Permissions>,
}
impl Snapshot {
    fn capture(selected: PathBuf) -> Result<Self, String> {
        let parent = selected
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .ok_or("保存位置缺少父目录。")?;
        let parent =
            fs::canonicalize(parent).map_err(|error| format!("无法访问保存目录：{error}"))?;
        let path = parent.join(selected.file_name().ok_or("文件名无效。")?);
        let (stamp, permissions) = match fs::symlink_metadata(&path) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_file() {
                    return Err("保存目标必须是普通文件，不能是链接或目录。".into());
                }
                (
                    Some(stamp(&read_bytes(&path)?)),
                    Some(metadata.permissions()),
                )
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (None, None),
            Err(error) => return Err(format!("无法检查保存位置：{error}")),
        };
        Ok(Self {
            path,
            stamp,
            permissions,
        })
    }

    fn unchanged(&self) -> Result<(), String> {
        let changed = || "文件已被其他应用修改、移动或替换，请重新打开或另存为。".to_string();
        let parent = self.path.parent().ok_or_else(changed)?;
        if fs::canonicalize(parent).map_err(|_| changed())? != parent {
            return Err(changed());
        }
        let now = Self::capture(self.path.clone())?;
        if now.path != self.path || now.stamp != self.stamp {
            return Err(changed());
        }
        Ok(())
    }
}

impl FileStore {
    pub fn open_files(&mut self, selected: Vec<PathBuf>) -> Result<Vec<NativeFile>, String> {
        if selected.len() > MAX_OPEN_FILES {
            return Err("一次最多打开 16 个文件。".into());
        }
        let mut output = Vec::new();
        let mut total = 0usize;
        // Register all files together, so a failed batch leaves no partial grants.
        let mut grants = Vec::new();
        for selected in selected {
            let path =
                fs::canonicalize(selected).map_err(|error| format!("无法访问文件：{error}"))?;
            let bytes = read_bytes(&path)?;
            total += bytes.len();
            if total > BATCH_LIMIT {
                return Err("本次打开的文件总量超过 100 MB，请分批打开。".into());
            }
            let hash = stamp(&bytes);
            let text = String::from_utf8(bytes)
                .map_err(|_| "请选择 UTF-8 编码的工作流、白板或代码图表文本文件。")?;
            output.push(NativeFile {
                name: name(&path)?,
                path: path_string(&path)?,
                text,
                stamp: hash.clone(),
            });
            grants.push((path, hash));
        }
        self.grants.extend(grants);
        Ok(output)
    }

    pub fn save_existing(
        &mut self,
        path: PathBuf,
        expected: Option<&str>,
        bytes: &[u8],
    ) -> Result<SaveResult, String> {
        let authorized = self
            .grants
            .get(&path)
            .ok_or("此路径尚未由文件选择器授权，请使用另存为。")?;
        let expected = expected.ok_or("缺少原文件版本，请重新打开或另存为。")?;
        if expected != authorized {
            return Err("当前编辑版本已过期，请重新打开或另存为。".into());
        }
        let target = Snapshot::capture(path.clone())?;
        if target.path != path || target.stamp.as_deref() != Some(expected) {
            return Err("文件已被其他应用修改或移动，请重新打开或另存为。".into());
        }
        self.save_target(target, bytes)
    }

    pub fn save_selected(&mut self, path: PathBuf, bytes: &[u8]) -> Result<SaveResult, String> {
        self.save_target(Snapshot::capture(path)?, bytes)
    }

    fn save_target(&mut self, target: Snapshot, bytes: &[u8]) -> Result<SaveResult, String> {
        if bytes.len() as u64 > FILE_LIMIT {
            return Err("文件超过 50 MB 大小上限。".into());
        }
        let result = SaveResult {
            name: name(&target.path)?,
            path: path_string(&target.path)?,
            stamp: stamp(bytes),
        };
        let parent = target.path.parent().ok_or("保存位置缺少父目录。")?;
        let mut staged = NamedTempFile::new_in(parent)
            .map_err(|error| format!("无法创建保存临时文件：{error}"))?;
        staged
            .write_all(bytes)
            .map_err(|error| format!("写入失败，原文件未改动：{error}"))?;
        if let Some(permissions) = target.permissions.clone() {
            staged
                .as_file()
                .set_permissions(permissions)
                .map_err(|error| format!("无法保留文件权限：{error}"))?;
        }
        staged
            .as_file()
            .sync_all()
            .map_err(|error| format!("文件同步失败，原文件未改动：{error}"))?;
        target.unchanged()?;
        if target.stamp.is_some() {
            // Atomic replacement on Windows and Unix; never delete the old file first.
            // No portable filesystem API can make a hash comparison and rename one CAS.
            staged
                .persist(&target.path)
                .map_err(|error| format!("保存失败，原文件未改动：{}", error.error))?;
        } else {
            staged
                .persist_noclobber(&target.path)
                .map_err(|error| format!("保存失败，目标可能已被其他应用创建：{}", error.error))?;
        }
        self.grants.insert(target.path, result.stamp.clone());
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn open_save_round_trip_updates_stamp_and_grant() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("流程.owf");
        fs::write(&path, "初稿").unwrap();
        let mut store = FileStore::default();
        let opened = store.open_files(vec![path]).unwrap().remove(0);
        assert_eq!(opened.text, "初稿");
        let saved = store
            .save_existing(
                PathBuf::from(&opened.path),
                Some(&opened.stamp),
                "下一版".as_bytes(),
            )
            .unwrap();
        assert_ne!(saved.stamp, opened.stamp);
        assert_eq!(fs::read_to_string(&saved.path).unwrap(), "下一版");
        assert!(store
            .save_existing(PathBuf::from(&saved.path), Some(&opened.stamp), b"stale")
            .is_err());
        store
            .save_existing(PathBuf::from(&saved.path), Some(&saved.stamp), b"newest")
            .unwrap();
    }
    #[test]
    fn unapproved_path_and_missing_stamp_cannot_overwrite() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("file.owf");
        fs::write(&path, b"original").unwrap();
        let mut store = FileStore::default();
        assert!(store
            .save_existing(path.clone(), Some(&stamp(b"original")), b"bad")
            .is_err());
        let opened = store.open_files(vec![path]).unwrap().remove(0);
        assert!(store
            .save_existing(PathBuf::from(&opened.path), None, b"bad")
            .is_err());
        assert_eq!(fs::read(&opened.path).unwrap(), b"original");
    }
    #[test]
    fn external_change_is_preserved() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("file.owf");
        fs::write(&path, b"original").unwrap();
        let mut store = FileStore::default();
        let opened = store.open_files(vec![path]).unwrap().remove(0);
        fs::write(&opened.path, b"external").unwrap();
        assert!(store
            .save_existing(PathBuf::from(&opened.path), Some(&opened.stamp), b"my edit")
            .is_err());
        assert_eq!(fs::read(&opened.path).unwrap(), b"external");
    }
    #[test]
    fn external_delete_is_not_recreated_by_save() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("file.owf");
        fs::write(&path, b"original").unwrap();
        let mut store = FileStore::default();
        let opened = store.open_files(vec![path]).unwrap().remove(0);
        fs::remove_file(&opened.path).unwrap();
        assert!(store
            .save_existing(PathBuf::from(&opened.path), Some(&opened.stamp), b"my edit")
            .is_err());
        assert!(!Path::new(&opened.path).exists());
    }
    #[test]
    fn selected_new_file_can_save_binary_then_update() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("export.png");
        let mut store = FileStore::default();
        let result = store
            .save_selected(path, &[137, 80, 78, 71, 0, 255])
            .unwrap();
        assert_eq!(fs::read(&result.path).unwrap(), &[137, 80, 78, 71, 0, 255]);
        store
            .save_existing(PathBuf::from(&result.path), Some(&result.stamp), b"next")
            .unwrap();
        assert_eq!(fs::read(&result.path).unwrap(), b"next");
    }
    #[test]
    fn invalid_utf8_aborts_whole_open_batch() {
        let temp = tempfile::tempdir().unwrap();
        let first = temp.path().join("first.owf");
        let bad = temp.path().join("bad.owf");
        fs::write(&first, b"valid").unwrap();
        fs::write(&bad, [255, 254]).unwrap();
        let mut store = FileStore::default();
        assert!(store.open_files(vec![first, bad]).is_err());
        assert!(store.grants.is_empty());
    }
    #[test]
    fn oversized_or_directory_input_is_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("large.owf");
        File::create(&path)
            .unwrap()
            .set_len(FILE_LIMIT + 1)
            .unwrap();
        let mut store = FileStore::default();
        assert!(store.open_files(vec![path]).is_err());
        assert!(store.open_files(vec![temp.path().to_path_buf()]).is_err());
    }
    #[test]
    fn selected_replacement_retains_permissions_and_no_temp_files() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("file.owf");
        fs::write(&path, b"old").unwrap();
        let mut store = FileStore::default();
        store.save_selected(path.clone(), b"replaced").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"replaced");
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 1);
    }
    #[test]
    fn filename_cannot_hide_a_path() {
        for invalid in ["", "..", "a/b.owf", "a\\b.owf", "bad\n.owf", "a:b.owf"] {
            assert!(validate_suggested_name(invalid).is_err());
        }
        assert!(validate_suggested_name("项目流程.owf").is_ok());
    }
    #[test]
    fn snapshot_detects_intervening_replacement() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("file.owf");
        fs::write(&path, b"old").unwrap();
        let target = Snapshot::capture(path.clone()).unwrap();
        fs::write(&path, b"changed").unwrap();
        assert!(target.unchanged().is_err());
        let absent = temp.path().join("new.owf");
        let target = Snapshot::capture(absent.clone()).unwrap();
        fs::write(absent, b"appeared").unwrap();
        assert!(target.unchanged().is_err());
    }
    #[cfg(unix)]
    #[test]
    fn symlink_replacement_and_parent_retarget_are_rejected() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("file.owf");
        let other = temp.path().join("other.owf");
        fs::write(&path, b"old").unwrap();
        fs::write(&other, b"keep").unwrap();
        let mut store = FileStore::default();
        let opened = store.open_files(vec![path.clone()]).unwrap().remove(0);
        fs::remove_file(&path).unwrap();
        symlink(&other, &path).unwrap();
        assert!(store
            .save_existing(PathBuf::from(opened.path), Some(&opened.stamp), b"bad")
            .is_err());
        assert!(store.save_selected(path, b"bad").is_err());
        assert_eq!(fs::read(&other).unwrap(), b"keep");
    }
}
