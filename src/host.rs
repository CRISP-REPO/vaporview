//! Host boundary traits — the seam between the target-agnostic engine and the
//! transport layer underneath it.
//!
//! Today there is exactly one implementation: `WasmHost` (in `lib.rs`), which
//! forwards every call to a wit-bindgen component import. The point of routing
//! the engine through a trait instead of calling those imports directly is that
//! a second implementation — a native binding that buffers bytes or invokes an
//! N-API callback — can be dropped in without touching the engine logic. That
//! native sink is Step 2 of the standalone-app migration.
//!
//! This module must stay free of any wit-bindgen / WASM-only references so it
//! compiles unchanged for a native target.

use std::io::{self, Read, Seek, SeekFrom};

/// Input boundary. The engine reads bytes through this trait instead of calling
/// the `fsread` component import directly. The WASM implementation forwards to
/// that import; a native implementation reads from a `std::fs::File` or an mmap.
///
/// `Send + Sync` is required because the active read continuation is parked in a
/// `lazy_static` `Mutex` between `loadfile` and `readbody`, and wellen's
/// `read_body` bounds its reader on `Sync`.
pub trait FileSource: Send + Sync {
    /// Read `len` bytes starting at `offset`.
    ///
    /// Contract: the adapter only ever requests in-bounds ranges
    /// (`offset + len <= file_size`), so an implementation MUST return exactly
    /// `len` bytes for such a request. A short return is treated as an I/O
    /// error by [`SourceReader::read`] rather than silently truncating.
    fn read(&self, offset: u64, len: u32) -> Vec<u8>;
}

/// Object-safe combination of `Read + Seek` (+ `Send` for the parked
/// continuation). Lets the engine store a `Box<dyn ReadSeek>` so its state types
/// don't name a concrete, target-specific reader — the WASM and native sources
/// erase to the same type behind this trait.
pub trait ReadSeek: Read + Seek + Send + Sync {}
impl<T: Read + Seek + Send + Sync> ReadSeek for T {}

/// Turns any [`FileSource`] into the `Read + Seek` stream that wellen consumes.
/// This adapter is target-agnostic — it holds the cursor and chunks large reads
/// (the component model caps copy sizes; harmless and cheap natively).
pub struct SourceReader<S: FileSource> {
    source: S,
    file_size: u64,
    cursor: u64,
}

impl<S: FileSource> SourceReader<S> {
    pub fn new(source: S, file_size: u64) -> Self {
        SourceReader { source, file_size, cursor: 0 }
    }
}

impl<S: FileSource> Read for SourceReader<S> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let mut bytes_read = 0;
        let read_size =
            std::cmp::min(buf.len() as u32, self.file_size as u32 - self.cursor as u32) as usize;
        while bytes_read < read_size {
            let chunk_size = std::cmp::min(read_size - bytes_read, 32768);
            let data = self.source.read(self.cursor, chunk_size as u32);
            // A correct FileSource returns exactly `chunk_size` bytes for an
            // in-bounds request. Guard against a short read so a misbehaving
            // (e.g. native) source surfaces as an error instead of panicking
            // inside `copy_from_slice`.
            if data.len() != chunk_size {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "FileSource returned fewer bytes than requested",
                ));
            }
            buf[bytes_read..bytes_read + chunk_size].copy_from_slice(&data);
            self.cursor += chunk_size as u64;
            bytes_read += chunk_size;
        }
        Ok(bytes_read)
    }

    fn read_exact(&mut self, buf: &mut [u8]) -> io::Result<()> {
        match self.read(buf) {
            Ok(size) if size == buf.len() => Ok(()),
            Ok(_) => Err(io::Error::new(io::ErrorKind::UnexpectedEof, "Failed to read all bytes")),
            Err(e) => Err(e),
        }
    }
}

impl<S: FileSource> Seek for SourceReader<S> {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        let new_cursor = match pos {
            SeekFrom::Start(offset) => offset,
            SeekFrom::End(offset) => (self.file_size as i64 + offset) as u64,
            SeekFrom::Current(offset) => (self.cursor as i64 + offset) as u64,
        };
        if (new_cursor as i64) < 0 {
            self.cursor = 0;
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "Invalid seek to negative position"));
        }
        self.cursor = std::cmp::min(new_cursor, self.file_size);
        Ok(self.cursor)
    }

    fn rewind(&mut self) -> io::Result<()> {
        self.cursor = 0;
        Ok(())
    }

    fn stream_position(&mut self) -> io::Result<u64> {
        Ok(self.cursor)
    }

    fn seek_relative(&mut self, offset: i64) -> io::Result<()> {
        let new_cursor = self.cursor as i64 + offset;
        if new_cursor < 0 {
            self.cursor = 0;
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "Invalid seek to negative position"));
        }
        self.cursor = std::cmp::min(new_cursor, self.file_size as i64) as u64;
        Ok(())
    }
}

/// Output boundary. The engine never emits results directly; it hands them to a
/// `DataSink`. Method names mirror the existing component imports so the WASM
/// implementation is a 1:1 forward, while a native implementation is free to
/// reinterpret them (e.g. append to a `Vec<u8>` data-plane buffer).
pub trait DataSink {
    /// Verbose/debug log line. Part of the complete output boundary; not yet
    /// routed through the trait on the WASM path (the `log` import is still
    /// called inline in a few spots) but required by the native sink.
    #[allow(dead_code)]
    fn log(&self, msg: &str);
    /// User-facing output-channel log line.
    fn output_log(&self, msg: &str);

    /// Emit the top-level scope hierarchy node.
    fn set_scope_top(&self, name: &str, id: u32, tpe: &str);
    /// Emit a top-level variable hierarchy node.
    fn set_var_top(
        &self,
        name: &str,
        id: u32,
        signal_id: u32,
        tpe: &str,
        encoding: &str,
        width: u32,
        msb: i32,
        lsb: i32,
        enum_type: &str,
    );
    /// Emit waveform-wide metadata (counts + timescale).
    fn set_metadata(&self, scope_count: u32, var_count: u32, timescale: u32, time_unit: &str);
    /// Emit chunking metadata for the time table.
    fn set_chunk_size(&self, chunk_size: u64, time_end: u64, time_table_length: u64);

    /// One chunk of uncompressed transition data (JSON text).
    fn send_transition_chunk(
        &self,
        signal_id: u32,
        total_chunks: u32,
        chunk_num: u32,
        min: f64,
        max: f64,
        data: &str,
    );
    /// One chunk of enum-definition data (JSON text).
    fn send_enum_chunk(&self, name: &str, total_chunks: u32, chunk_num: u32, data: &str);
    /// One chunk of LZ4-compressed transition data (raw bytes).
    fn send_compressed_transition(
        &self,
        signal_id: u32,
        signal_width: u32,
        total_chunks: u32,
        chunk_num: u32,
        min: f64,
        max: f64,
        data: &[u8],
        original_size: u32,
    );
}
