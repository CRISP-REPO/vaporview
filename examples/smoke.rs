//! Native smoke test: load a waveform through the engine's native binding and
//! print what the DataSink captured. Run with:
//!   cargo run --no-default-features --features native --example smoke -- <file.vcd>

fn main() {
    let path = std::env::args().nth(1).expect("usage: smoke <waveform-file>");
    let data = filehandler::native_api::load_waveform(&path).expect("failed to load waveform");

    println!(
        "loaded: scopes={} vars={} timescale={}{} time_end={} chunk_size={} time_table_len={}",
        data.scope_count,
        data.var_count,
        data.timescale,
        data.time_unit,
        data.time_end,
        data.chunk_size,
        data.time_table_length,
    );
    println!("top scopes: {:?}", data.scopes);
    println!("top vars:   {:?}", data.vars);

    // Descend into the first scope to collect signal ids, then pull their
    // transition data — exercising the heavy path (getchildren -> getsignaldata
    // -> parse_value_change_data -> DataSink).
    let host = filehandler::native_api::NativeHost::default();
    if let Some((_, scope_id, _)) = data.scopes.first() {
        let children = filehandler::native_api::get_children(&host, *scope_id, 0);
        println!("children of scope {}: {}", scope_id, children);

        // crude extract of every `"signalId": N` from the JSON
        let ids: Vec<u32> = children
            .split("\"signalId\":")
            .skip(1)
            .filter_map(|s| s.trim_start().split(|c: char| !c.is_ascii_digit()).next())
            .filter_map(|s| s.parse::<u32>().ok())
            .collect();

        if !ids.is_empty() {
            filehandler::native_api::get_signal_data(&host, ids.clone());
            let sig = host.data.lock().unwrap();
            let bytes: usize = sig.transitions.iter().map(|t| t.data.len()).sum();
            println!(
                "signal data for ids {:?}: {} uncompressed + {} compressed chunk(s), {} bytes; first: {}",
                ids,
                sig.transitions.len(),
                sig.compressed.len(),
                bytes,
                sig.transitions.first().map(|t| t.data.as_str()).unwrap_or("")
            );
        }
    }
    filehandler::native_api::unload();
}
