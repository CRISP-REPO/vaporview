//! N-API binding — the Node-facing surface of the VaporView engine.
//!
//! This is the Electron-side counterpart to the WASM Guest: it wraps the same
//! `filehandler::native_api` functions (which drive the shared engine through
//! `DataSink`/`FileSource`) so the Electron main process can load and query
//! waveforms via a normal `require()`d native addon.
//!
//! Engine state is global (one loaded waveform at a time), mirroring the
//! extension's design. The data-plane buffer return (raw transition bytes for
//! the WebGPU canvas) is the next refinement — today `get_signal_data` returns
//! summary stats proving the round-trip.

use napi::bindgen_prelude::Buffer;
use napi_derive::napi;

#[napi(object)]
pub struct ScopeInfo {
    pub name: String,
    pub id: u32,
    pub scope_type: String,
}

#[napi(object)]
pub struct VarInfo {
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

#[napi(object)]
pub struct WaveformInfo {
    pub scope_count: u32,
    pub var_count: u32,
    pub timescale: u32,
    pub time_unit: String,
    /// u64 time values surfaced as f64 (sufficient for display/zoom math).
    pub time_end: f64,
    pub chunk_size: f64,
    pub time_table_length: f64,
    pub scopes: Vec<ScopeInfo>,
    pub vars: Vec<VarInfo>,
}

#[napi(object)]
pub struct TransitionChunk {
    pub signal_id: u32,
    pub total_chunks: u32,
    pub chunk_num: u32,
    pub min: f64,
    pub max: f64,
    pub data: String,
}

#[napi(object)]
pub struct CompressedChunk {
    pub signal_id: u32,
    pub signal_width: u32,
    pub total_chunks: u32,
    pub chunk_num: u32,
    pub min: f64,
    pub max: f64,
    pub data: Buffer,
    pub original_size: u32,
}

#[napi(object)]
pub struct EnumChunk {
    pub name: String,
    pub total_chunks: u32,
    pub chunk_num: u32,
    pub data: String,
}

#[napi(object)]
pub struct SignalData {
    pub transitions: Vec<TransitionChunk>,
    pub compressed: Vec<CompressedChunk>,
    pub enums: Vec<EnumChunk>,
}

/// Load a waveform file's header + body into the engine and return the hierarchy
/// + metadata. Mirrors the extension's `loadfile` + `readbody`.
#[napi]
pub fn load_waveform(path: String) -> napi::Result<WaveformInfo> {
    let data = filehandler::native_api::load_waveform(&path)
        .map_err(|e| napi::Error::from_reason(format!("failed to load {path}: {e}")))?;
    Ok(WaveformInfo {
        scope_count: data.scope_count,
        var_count: data.var_count,
        timescale: data.timescale,
        time_unit: data.time_unit,
        time_end: data.time_end as f64,
        chunk_size: data.chunk_size as f64,
        time_table_length: data.time_table_length as f64,
        scopes: data
            .scopes
            .into_iter()
            .map(|(name, id, scope_type)| ScopeInfo { name, id, scope_type })
            .collect(),
        vars: data
            .vars
            .into_iter()
            .map(|v| VarInfo {
                name: v.name,
                netlist_id: v.netlist_id,
                signal_id: v.signal_id,
                var_type: v.var_type,
                encoding: v.encoding,
                width: v.width,
                msb: v.msb,
                lsb: v.lsb,
                enum_type: v.enum_type,
            })
            .collect(),
    })
}

/// Children (scopes + vars) of a scope, as JSON. Paginated via `start_index`.
#[napi]
pub fn get_children(scope_id: u32, start_index: u32) -> String {
    let host = filehandler::native_api::NativeHost::default();
    filehandler::native_api::get_children(&host, scope_id, start_index)
}

/// Pull transition data for the given signal ids — the chunks the webview's
/// data manager consumes as `update-waveform-chunk(-compressed)` / `update-enum-chunk`.
#[napi]
pub fn get_signal_data(signal_ids: Vec<u32>) -> SignalData {
    let host = filehandler::native_api::NativeHost::default();
    filehandler::native_api::get_signal_data(&host, signal_ids);
    let mut d = host.data.lock().unwrap();
    SignalData {
        transitions: std::mem::take(&mut d.transitions)
            .into_iter()
            .map(|t| TransitionChunk {
                signal_id: t.signal_id,
                total_chunks: t.total_chunks,
                chunk_num: t.chunk_num,
                min: t.min,
                max: t.max,
                data: t.data,
            })
            .collect(),
        compressed: std::mem::take(&mut d.compressed)
            .into_iter()
            .map(|c| CompressedChunk {
                signal_id: c.signal_id,
                signal_width: c.signal_width,
                total_chunks: c.total_chunks,
                chunk_num: c.chunk_num,
                min: c.min,
                max: c.max,
                data: c.data.into(),
                original_size: c.original_size,
            })
            .collect(),
        enums: std::mem::take(&mut d.enums)
            .into_iter()
            .map(|e| EnumChunk {
                name: e.name,
                total_chunks: e.total_chunks,
                chunk_num: e.chunk_num,
                data: e.data,
            })
            .collect(),
    }
}

#[napi]
pub fn search_netlist(query: String) -> String {
    filehandler::native_api::search_netlist(query)
}

#[napi]
pub fn unload() {
    filehandler::native_api::unload();
}
