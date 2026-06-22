//! Native binding (feature "native") — the standalone-app side of the engine.
//!
//! This is the second implementation of the host boundary, proving the engine
//! compiles and links with no wit-bindgen / WASM dependency. `NativeFileSource`
//! reads from a real file via positioned reads; `NativeHost` collects whatever
//! the engine emits. The same `engine_*` functions the WASM Guest calls are
//! driven here.
//!
//! Step 3 wraps these `pub fn`s in an N-API (Electron) or `tauri::command`
//! surface and streams the collected data to the WebGPU renderer.

use std::fs::File;
use std::os::unix::fs::FileExt;
use std::sync::Mutex;

use crate::host::{DataSink, FileSource, ReadSeek, SourceReader};
use crate::{
    engine_getchildren, engine_getenumdata, engine_getparametervalues, engine_getsignaldata,
    engine_getvaluesattime, engine_loadfile, engine_readbody, engine_searchnetlist, engine_unload,
};

/// File-backed [`FileSource`] using positioned (`pread`) reads, so it satisfies
/// the `&self` + exact-length contract without an internal cursor lock.
pub struct NativeFileSource {
    file: File,
}

impl NativeFileSource {
    /// Open `path`, returning the source and the file size the engine needs.
    pub fn open(path: &str) -> std::io::Result<(Self, u64)> {
        let file = File::open(path)?;
        let size = file.metadata()?.len();
        Ok((NativeFileSource { file }, size))
    }
}

impl FileSource for NativeFileSource {
    fn read(&self, offset: u64, len: u32) -> Vec<u8> {
        let mut buf = vec![0u8; len as usize];
        let mut filled = 0usize;
        while filled < buf.len() {
            match self.file.read_at(&mut buf[filled..], offset + filled as u64) {
                Ok(0) => break,
                Ok(n) => filled += n,
                Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
        buf.truncate(filled);
        buf
    }
}

/// A top-level variable with the full field set the webview's netlist tree needs.
#[derive(Default, Debug, Clone)]
pub struct VarTop {
    pub name: String,
    pub netlist_id: u32,
    pub signal_id: u32,
    pub var_type: String,
    pub encoding: String,
    pub width: u32,
    pub msb: i32,
    pub lsb: i32,
    pub enum_type: String,
}

/// One uncompressed transition chunk (mirrors `update-waveform-chunk`).
#[derive(Default, Debug, Clone)]
pub struct TransitionChunk {
    pub signal_id: u32,
    pub total_chunks: u32,
    pub chunk_num: u32,
    pub min: f64,
    pub max: f64,
    pub data: String,
}

/// One LZ4-compressed transition chunk (mirrors `update-waveform-chunk-compressed`).
#[derive(Default, Debug, Clone)]
pub struct CompressedChunk {
    pub signal_id: u32,
    pub signal_width: u32,
    pub total_chunks: u32,
    pub chunk_num: u32,
    pub min: f64,
    pub max: f64,
    pub data: Vec<u8>,
    pub original_size: u32,
}

/// One enum-definition chunk (mirrors `update-enum-chunk`).
#[derive(Default, Debug, Clone)]
pub struct EnumChunk {
    pub name: String,
    pub total_chunks: u32,
    pub chunk_num: u32,
    pub data: String,
}

/// Everything the engine emits, captured in memory for the data plane.
#[derive(Default, Debug)]
pub struct NativeData {
    pub scopes: Vec<(String, u32, String)>,
    pub vars: Vec<VarTop>,
    pub scope_count: u32,
    pub var_count: u32,
    pub timescale: u32,
    pub time_unit: String,
    pub chunk_size: u64,
    pub time_end: u64,
    pub time_table_length: u64,
    pub transitions: Vec<TransitionChunk>,
    pub compressed: Vec<CompressedChunk>,
    pub enums: Vec<EnumChunk>,
    pub logs: Vec<String>,
}

/// Native [`DataSink`] — collects engine output into [`NativeData`].
#[derive(Default)]
pub struct NativeHost {
    pub data: Mutex<NativeData>,
}

impl DataSink for NativeHost {
    fn log(&self, msg: &str) {
        self.data.lock().unwrap().logs.push(msg.to_string());
    }
    fn output_log(&self, msg: &str) {
        self.data.lock().unwrap().logs.push(msg.to_string());
    }
    fn set_scope_top(&self, name: &str, id: u32, tpe: &str) {
        self.data.lock().unwrap().scopes.push((name.to_string(), id, tpe.to_string()));
    }
    fn set_var_top(&self, name: &str, id: u32, signal_id: u32, tpe: &str, encoding: &str, width: u32, msb: i32, lsb: i32, enum_type: &str) {
        self.data.lock().unwrap().vars.push(VarTop {
            name: name.to_string(),
            netlist_id: id,
            signal_id,
            var_type: tpe.to_string(),
            encoding: encoding.to_string(),
            width,
            msb,
            lsb,
            enum_type: enum_type.to_string(),
        });
    }
    fn set_metadata(&self, scope_count: u32, var_count: u32, timescale: u32, time_unit: &str) {
        let mut d = self.data.lock().unwrap();
        d.scope_count = scope_count;
        d.var_count = var_count;
        d.timescale = timescale;
        d.time_unit = time_unit.to_string();
    }
    fn set_chunk_size(&self, chunk_size: u64, time_end: u64, time_table_length: u64) {
        let mut d = self.data.lock().unwrap();
        d.chunk_size = chunk_size;
        d.time_end = time_end;
        d.time_table_length = time_table_length;
    }
    fn send_transition_chunk(&self, signal_id: u32, total_chunks: u32, chunk_num: u32, min: f64, max: f64, data: &str) {
        self.data.lock().unwrap().transitions.push(TransitionChunk {
            signal_id,
            total_chunks,
            chunk_num,
            min,
            max,
            data: data.to_string(),
        });
    }
    fn send_enum_chunk(&self, name: &str, total_chunks: u32, chunk_num: u32, data: &str) {
        self.data.lock().unwrap().enums.push(EnumChunk {
            name: name.to_string(),
            total_chunks,
            chunk_num,
            data: data.to_string(),
        });
    }
    fn send_compressed_transition(&self, signal_id: u32, signal_width: u32, total_chunks: u32, chunk_num: u32, min: f64, max: f64, data: &[u8], original_size: u32) {
        self.data.lock().unwrap().compressed.push(CompressedChunk {
            signal_id,
            signal_width,
            total_chunks,
            chunk_num,
            min,
            max,
            data: data.to_vec(),
            original_size,
        });
    }
}

/// Load a waveform file's header + body into the engine's global state and return
/// the captured hierarchy/metadata. Mirrors the WASM `loadfile` + `readbody`.
pub fn load_waveform(path: &str) -> std::io::Result<NativeData> {
    let (source, size) = NativeFileSource::open(path)?;
    let reader: Box<dyn ReadSeek> = Box::new(SourceReader::new(source, size));
    let host = NativeHost::default();
    engine_loadfile(&host, reader, size, false, 1 << 16);
    engine_readbody(&host);
    Ok(host.data.into_inner().unwrap())
}

// --- Remaining engine surface, exposed for the native binding (Step 3). ---

pub fn get_children(host: &NativeHost, id: u32, start_index: u32) -> String {
    engine_getchildren(host, id, start_index)
}
pub fn get_signal_data(host: &NativeHost, signal_ids: Vec<u32>) {
    engine_getsignaldata(host, signal_ids);
}
pub fn get_enum_data(host: &NativeHost, netlist_ids: Vec<u32>) {
    engine_getenumdata(host, netlist_ids);
}
pub fn get_parameter_values(signal_ids: Vec<u32>) -> String {
    engine_getparametervalues(signal_ids)
}
pub fn get_values_at_time(time: u64, paths: String) -> String {
    engine_getvaluesattime(time, paths)
}
pub fn search_netlist(query: String) -> String {
    engine_searchnetlist(query, 0xFFFFFFFF)
}
pub fn unload() {
    engine_unload();
}
