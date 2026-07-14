// Netlist Explorer webview (editor-pane).
//
// Renders the design scope tree lazily (children fetched per expand, fsdb-safe),
// and lets the user add signals to the waveform by:
//   • double-clicking a signal,
//   • selecting one/many and pressing "Add" (or Enter),
//   • dragging onto the waveform using the custom MIME `application/x-vaporview-netlist`
//     (plain HTML5 DnD — no Shift required, unlike the old tree's resourceUri drag).

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(s: unknown): void;
};

const vscode = acquireVsCodeApi();

const NETLIST_MIME = 'application/x-vaporview-netlist';
const ROOT_KEY = '__root__';
// Self-contained chevron (points right; CSS rotates it 90° when the scope is expanded).
const CHEVRON_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M10.072 8.024L5.715 3.667l.618-.62L11 7.716v.618L6.333 13l-.618-.619 4.357-4.357z"/></svg>';

interface NetlistChild {
  name: string;
  label: string;
  type: string;
  instancePath: string;
  netlistId: number;
  signalId: number;
  isScope: boolean;
  width: number;
  msb: number;
  lsb: number;
  encoding: string;
}

interface ScopeContainer {
  childrenEl: HTMLElement;
  depth: number;
  loaded: boolean;
  pendingExpand: boolean;
  twistEl?: HTMLElement;
}

const rootEl = document.getElementById('netlist-explorer-root') as HTMLElement;
const resultsEl = document.getElementById('ne-results') as HTMLElement;
const filterEl = document.getElementById('ne-filter') as HTMLInputElement;
const addBtn = document.getElementById('ne-add') as HTMLButtonElement;
const hintEl = document.getElementById('ne-hint') as HTMLElement;

// scopePath key → container. Root uses ROOT_KEY and the top-level element.
const scopeContainers = new Map<string, ScopeContainer>();
// Ordered selection of variables (insertion order = add order).
const selected = new Map<number, { netlistId: number; instancePath: string; el: HTMLElement }>();
let anchorNetlistId: number | null = null;
// Reveal-in-progress target instance path.
let pendingReveal: string | null = null;
// Search mode: results are a flat list from a backend netlist search (keyed by path).
let searchMode = false;
const selectedResults = new Map<string, { instancePath: string; el: HTMLElement }>();
let anchorResultPath: string | null = null;
let searchTimer: ReturnType<typeof setTimeout> | undefined;

function log(message: string) {
  vscode.postMessage({ command: 'logOutput', message });
}

function keyOf(scopePath: string | null | undefined): string {
  return scopePath ? scopePath : ROOT_KEY;
}

function requestChildren(scopePath: string | undefined) {
  vscode.postMessage({ command: 'getScopeChildren', scopePath });
}

function resetTree() {
  rootEl.innerHTML = '';
  scopeContainers.clear();
  selected.clear();
  anchorNetlistId = null;
  pendingReveal = null;
  addBtn.disabled = true;
  scopeContainers.set(ROOT_KEY, { childrenEl: rootEl, depth: 0, loaded: false, pendingExpand: false });
}

// ─── Rendering ───

function makeRow(child: NetlistChild, depth: number): HTMLElement {
  const row = document.createElement('div');
  row.className = 'ne-row';
  row.style.paddingLeft = (4 + depth * 12) + 'px';
  row.dataset.netlistId = String(child.netlistId);
  row.dataset.instancePath = child.instancePath;

  // Inline-SVG chevron (rotated when expanded). The @vscode/codicons font is NOT
  // bundled into the Crisp build, so codicon classes render blank — use self-contained SVG.
  const twist = document.createElement('span');
  twist.className = 'ne-twist';
  if (child.isScope) {
    twist.innerHTML = CHEVRON_SVG;
  } else {
    twist.classList.add('leaf');
  }
  row.appendChild(twist);

  const label = document.createElement('span');
  label.className = 'ne-label';
  label.textContent = child.name || child.label;
  row.appendChild(label);

  if (!child.isScope && child.width && child.width > 1) {
    const w = document.createElement('span');
    w.className = 'ne-width';
    w.textContent = child.msb !== child.lsb ? `[${child.msb}:${child.lsb}]` : `[${child.width}]`;
    row.appendChild(w);
  }

  if (child.isScope) {
    row.addEventListener('click', () => toggleScope(child.instancePath));
  } else {
    row.dataset.var = '1';
    row.draggable = true;
    row.addEventListener('click', (e) => selectVar(child, row, e));
    row.addEventListener('dblclick', () => addSignals([{ netlistId: child.netlistId, instancePath: child.instancePath }]));
    row.addEventListener('dragstart', (e) => onDragStart(child, e));
  }

  return row;
}

function renderChildren(scopePath: string | null, children: NetlistChild[]) {
  const key = keyOf(scopePath);
  const container = scopeContainers.get(key);
  if (!container) { return; }

  container.childrenEl.innerHTML = '';
  container.loaded = true;

  for (const child of children) {
    const row = makeRow(child, container.depth);
    container.childrenEl.appendChild(row);

    if (child.isScope) {
      const kids = document.createElement('div');
      kids.className = 'ne-children';
      container.childrenEl.appendChild(kids);
      const twist = row.querySelector('.ne-twist') as HTMLElement;
      scopeContainers.set(child.instancePath, {
        childrenEl: kids,
        depth: container.depth + 1,
        loaded: false,
        pendingExpand: false,
        twistEl: twist,
      });
    }
  }

  // If this scope was expanded by the user (or reveal), show it now.
  if (container.pendingExpand) {
    container.pendingExpand = false;
    setExpanded(key, true);
  }

  if (pendingReveal) { advanceReveal(); }
}

function setExpanded(key: string, expanded: boolean) {
  const container = scopeContainers.get(key);
  if (!container || key === ROOT_KEY) { return; }
  container.childrenEl.classList.toggle('expanded', expanded);
  if (container.twistEl) {
    container.twistEl.classList.toggle('expanded', expanded);
  }
}

function toggleScope(scopePath: string) {
  const container = scopeContainers.get(scopePath);
  if (!container) { return; }
  if (!container.loaded) {
    container.pendingExpand = true;
    requestChildren(scopePath);
    return;
  }
  const isExpanded = container.childrenEl.classList.contains('expanded');
  setExpanded(scopePath, !isExpanded);
}

// ─── Selection ───

function refreshSelectionClasses() {
  rootEl.querySelectorAll('.ne-row.selected').forEach((r) => r.classList.remove('selected'));
  for (const { el } of selected.values()) { el.classList.add('selected'); }
  updateAddButton();
}

function selectVar(child: NetlistChild, row: HTMLElement, e: MouseEvent) {
  const id = child.netlistId;
  if (e.shiftKey && anchorNetlistId !== null) {
    // Range over currently-visible variable rows in DOM order.
    const vars = Array.from(rootEl.querySelectorAll('.ne-row[data-var="1"]')) as HTMLElement[];
    const visible = vars.filter((v) => !v.classList.contains('hidden'));
    const ai = visible.findIndex((v) => v.dataset.netlistId === String(anchorNetlistId));
    const bi = visible.findIndex((v) => v === row);
    if (ai !== -1 && bi !== -1) {
      const [lo, hi] = ai < bi ? [ai, bi] : [bi, ai];
      selected.clear();
      for (let i = lo; i <= hi; i++) {
        const el = visible[i];
        selected.set(Number(el.dataset.netlistId), {
          netlistId: Number(el.dataset.netlistId),
          instancePath: el.dataset.instancePath || '',
          el,
        });
      }
    }
  } else if (e.ctrlKey || e.metaKey) {
    if (selected.has(id)) { selected.delete(id); }
    else { selected.set(id, { netlistId: id, instancePath: child.instancePath, el: row }); }
    anchorNetlistId = id;
  } else {
    selected.clear();
    selected.set(id, { netlistId: id, instancePath: child.instancePath, el: row });
    anchorNetlistId = id;
  }
  refreshSelectionClasses();
}

// ─── Add + drag ───

function addSignals(items: Array<{ netlistId?: number; instancePath: string }>) {
  if (items.length === 0) { return; }
  vscode.postMessage({ command: 'addSignals', items });
}

function onDragStart(child: NetlistChild, e: DragEvent) {
  if (!e.dataTransfer) { return; }
  // Drag the whole selection if this row is part of it, else just this row.
  let items: Array<{ netlistId: number; instancePath: string }>;
  if (selected.has(child.netlistId) && selected.size > 0) {
    items = Array.from(selected.values()).map((v) => ({ netlistId: v.netlistId, instancePath: v.instancePath }));
  } else {
    items = [{ netlistId: child.netlistId, instancePath: child.instancePath }];
  }
  e.dataTransfer.setData(NETLIST_MIME, JSON.stringify(items));
  e.dataTransfer.effectAllowed = 'copy';
  log(`dragstart ${items.length} signal(s)`);
}

// ─── Search (backend netlist search) ───

interface SearchResult { instancePath: string; type: string; isVar: boolean; width: number; msb: number; lsb: number; }

function updateAddButton() {
  addBtn.disabled = searchMode ? selectedResults.size === 0 : selected.size === 0;
}

function showTree() {
  searchMode = false;
  selectedResults.clear();
  anchorResultPath = null;
  resultsEl.style.display = 'none';
  resultsEl.innerHTML = '';
  rootEl.style.display = '';
  updateAddButton();
}

function renderResults(results: SearchResult[]) {
  searchMode = true;
  selectedResults.clear();
  anchorResultPath = null;
  rootEl.style.display = 'none';
  resultsEl.style.display = '';
  resultsEl.innerHTML = '';
  if (results.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'ne-empty';
    empty.textContent = 'No matching signals';
    resultsEl.appendChild(empty);
    updateAddButton();
    return;
  }
  for (const r of results) { resultsEl.appendChild(makeResultRow(r)); }
  updateAddButton();
}

function makeResultRow(r: SearchResult): HTMLElement {
  const row = document.createElement('div');
  row.className = 'ne-row';
  row.style.paddingLeft = '6px';
  row.dataset.instancePath = r.instancePath;
  row.dataset.var = '1';
  row.draggable = true;

  const twist = document.createElement('span');
  twist.className = 'ne-twist leaf';
  row.appendChild(twist);

  const label = document.createElement('span');
  label.className = 'ne-label';
  label.textContent = r.instancePath;
  row.appendChild(label);

  if (r.width && r.width > 1) {
    const w = document.createElement('span');
    w.className = 'ne-width';
    w.textContent = r.msb !== r.lsb ? `[${r.msb}:${r.lsb}]` : `[${r.width}]`;
    row.appendChild(w);
  }

  row.addEventListener('click', (e) => selectResult(r.instancePath, row, e));
  row.addEventListener('dblclick', () => addSignals([{ instancePath: r.instancePath }]));
  row.addEventListener('dragstart', (e) => onResultDragStart(r.instancePath, e));
  return row;
}

function selectResult(instancePath: string, row: HTMLElement, e: MouseEvent) {
  const rows = Array.from(resultsEl.querySelectorAll('.ne-row')) as HTMLElement[];

  if (e.shiftKey && anchorResultPath !== null) {
    // Range-select from the anchor to the clicked row (DOM order).
    const ai = rows.findIndex((r) => r.dataset.instancePath === anchorResultPath);
    const bi = rows.findIndex((r) => r === row);
    if (ai !== -1 && bi !== -1) {
      const [lo, hi] = ai < bi ? [ai, bi] : [bi, ai];
      selectedResults.clear();
      rows.forEach((r) => r.classList.remove('selected'));
      for (let i = lo; i <= hi; i++) {
        const el = rows[i];
        const p = el.dataset.instancePath || '';
        selectedResults.set(p, { instancePath: p, el });
        el.classList.add('selected');
      }
    }
    updateAddButton();
    return;
  }

  if (e.ctrlKey || e.metaKey) {
    if (selectedResults.has(instancePath)) {
      selectedResults.delete(instancePath);
      row.classList.remove('selected');
    } else {
      selectedResults.set(instancePath, { instancePath, el: row });
      row.classList.add('selected');
    }
  } else {
    selectedResults.clear();
    rows.forEach((r) => r.classList.remove('selected'));
    selectedResults.set(instancePath, { instancePath, el: row });
    row.classList.add('selected');
  }
  anchorResultPath = instancePath;
  updateAddButton();
}

function onResultDragStart(instancePath: string, e: DragEvent) {
  if (!e.dataTransfer) { return; }
  const paths = (selectedResults.has(instancePath) && selectedResults.size > 0)
    ? Array.from(selectedResults.values()).map((v) => v.instancePath)
    : [instancePath];
  e.dataTransfer.setData(NETLIST_MIME, JSON.stringify(paths.map((p) => ({ instancePath: p }))));
  e.dataTransfer.effectAllowed = 'copy';
  log(`dragstart ${paths.length} search result(s)`);
}

// ─── Reveal (expand ancestors + scroll) ───

function advanceReveal() {
  if (!pendingReveal) { return; }
  const target = pendingReveal;

  // Already rendered? select + scroll + done.
  const targetRow = rootEl.querySelector(`.ne-row[data-instance-path="${cssEscape(target)}"]`) as HTMLElement | null;
  if (targetRow) {
    targetRow.scrollIntoView({ block: 'center' });
    if (targetRow.dataset.var === '1') {
      selected.clear();
      selected.set(Number(targetRow.dataset.netlistId), {
        netlistId: Number(targetRow.dataset.netlistId),
        instancePath: target,
        el: targetRow,
      });
      anchorNetlistId = Number(targetRow.dataset.netlistId);
      refreshSelectionClasses();
    }
    pendingReveal = null;
    return;
  }

  // Otherwise expand the deepest loaded ancestor toward the target.
  const parts = target.split('.');
  for (let i = parts.length - 1; i >= 1; i--) {
    const ancestor = parts.slice(0, i).join('.');
    const container = scopeContainers.get(ancestor);
    if (container) {
      if (!container.loaded) {
        container.pendingExpand = true;
        requestChildren(ancestor);
      } else {
        setExpanded(ancestor, true);
        // Next segment's container may now exist but be unloaded.
      }
      return;
    }
  }
  // No ancestor container yet — root should exist; request root.
  requestChildren(undefined);
}

function cssEscape(s: string): string {
  return s.replace(/["\\]/g, '\\$&');
}

// ─── Wiring ───

function addCurrentSelection() {
  if (searchMode) {
    addSignals(Array.from(selectedResults.values()).map((v) => ({ instancePath: v.instancePath })));
  } else {
    addSignals(Array.from(selected.values()).map((v) => ({ netlistId: v.netlistId, instancePath: v.instancePath })));
  }
}

addBtn.addEventListener('click', addCurrentSelection);

// Typing runs a backend netlist search (matches signals across the whole design,
// including collapsed scopes). Empty query restores the tree.
filterEl.addEventListener('input', () => {
  const q = filterEl.value.trim();
  if (searchTimer) { clearTimeout(searchTimer); }
  if (q === '') { showTree(); return; }
  searchTimer = setTimeout(() => vscode.postMessage({ command: 'search', query: q }), 150);
});
filterEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { addCurrentSelection(); }
});

window.addEventListener('message', (event) => {
  const msg = event.data;
  switch (msg?.command) {
    case 'setDocument': {
      hintEl.style.display = 'none';
      filterEl.value = '';
      showTree();
      resetTree();
      requestChildren(undefined);
      break;
    }
    case 'clearDocument': {
      filterEl.value = '';
      showTree();
      resetTree();
      rootEl.innerHTML = '';
      hintEl.style.display = '';
      break;
    }
    case 'scopeChildren': {
      renderChildren(msg.scopePath ?? null, msg.children || []);
      break;
    }
    case 'searchResults': {
      // Ignore stale responses that no longer match the current query.
      if (filterEl.value.trim() !== msg.query) { break; }
      renderResults(msg.results || []);
      break;
    }
    case 'revealPath': {
      pendingReveal = msg.instancePath || null;
      advanceReveal();
      break;
    }
    default: break;
  }
});

resetTree();
rootEl.style.display = 'none';
vscode.postMessage({ command: 'ready' });
