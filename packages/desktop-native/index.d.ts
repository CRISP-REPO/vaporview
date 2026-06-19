export interface ScopeInfo {
  name: string
  id: number
  scopeType: string
}

export interface VarInfo {
  name: string
  netlistId: number
  signalId: number
}

export interface WaveformInfo {
  scopeCount: number
  varCount: number
  timescale: number
  timeUnit: string
  timeEnd: number
  chunkSize: number
  timeTableLength: number
  scopes: ScopeInfo[]
  vars: VarInfo[]
}

export interface SignalDataStats {
  chunks: number
  bytes: number
}

/** Load a waveform file (VCD/FST/GHW) into the engine; returns hierarchy + metadata. */
export function loadWaveform(path: string): WaveformInfo
/** Children (scopes + vars) of a scope, as JSON; paginated via startIndex. */
export function getChildren(scopeId: number, startIndex: number): string
/** Pull transition data for the given signal ids (summary stats for now). */
export function getSignalData(signalIds: number[]): SignalDataStats
/** Search the netlist; returns JSON results. */
export function searchNetlist(query: string): string
/** Drop the loaded waveform and free engine state. */
export function unload(): void
