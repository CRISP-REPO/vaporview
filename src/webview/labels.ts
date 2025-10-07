import { EventHandler, viewport, arrayMove, NetlistId, ActionType, viewerState, dataManager, RowId, getChildrenByGroupId, getIndexInGroup, sendWebviewContext, handleClickSelection} from './vaporview';
import { ValueFormat } from './value_format';
import { vscode, getParentGroupId } from './vaporview';
import { SignalGroup, VariableItem, htmlSafe } from './signal_item';

export class LabelsPanels {

  resizeElement: any = null;
  events: EventHandler;

  webview: HTMLElement;
  labels: HTMLElement;
  valueDisplay: HTMLElement;
  labelsScroll: HTMLElement;
  valuesScroll: HTMLElement;
  resize1: HTMLElement;
  resize2: HTMLElement;
  dragDivider: HTMLElement | null = null;
  dragCursorTag: HTMLElement | null = null;
  dragCursorText: string = "";

  // drag handler variables
  labelsList: any            = [];
  idleItems: any             = [];
  idleGroups: any            = [];
  draggableRows: RowId[]     = [];
  draggableItem: any         = null;
  closestItem: any           = null;
  groupContainer: any        = null;
  indexOffset: number        = 0;
  pointerStartX: any         = null;
  pointerStartY: any         = null;
  scrollStartY: any          = null;
  resizeIndex: any           = null;
  defaultDragDividerY: number= 0;
  dragActive: boolean        = false;
  dragInProgress: boolean    = false;
  dragFreeze: boolean        = true;
  dragFreezeTimeout: any     = null;
  renameActive: boolean      = false;
  valueAtMarker: any         = {};
  

  constructor(events: EventHandler) {
    this.events = events;
  try { console.log('DEBUG WFSELECT labelsVersion', { version: 'v5', timestamp: Date.now() }); } catch(_){ /* noop */ }

    const webview      = document.getElementById('vaporview-top');
    const labels       = document.getElementById('waveform-labels');
    const valueDisplay = document.getElementById('value-display');
    const labelsScroll = document.getElementById('waveform-labels-container');
    const valuesScroll = document.getElementById('value-display-container');
    const resize1      = document.getElementById("resize-1");
    const resize2      = document.getElementById("resize-2");

    if (webview === null || labels === null || valueDisplay === null ||
       labelsScroll === null || valuesScroll === null || resize1 === null ||
       resize2 === null) {
      throw new Error("Could not find all required elements");
    }

    this.webview      = webview;
    this.labels       = labels;
    this.valueDisplay = valueDisplay;
    this.labelsScroll = labelsScroll;
    this.valuesScroll = valuesScroll;
    this.resize1      = resize1;
    this.resize2      = resize2;

    this.dragMove              = this.dragMove.bind(this);
    this.resize                = this.resize.bind(this);
    this.dragEnd               = this.dragEnd.bind(this);
    this.dragStart             = this.dragStart.bind(this);
    this.handleResizeMousedown = this.handleResizeMousedown.bind(this);
    this.handleMarkerSet       = this.handleMarkerSet.bind(this);
    this.handleSignalSelect    = this.handleSignalSelect.bind(this);
    this.handleReorderSignals  = this.handleReorderSignals.bind(this);
    this.handleRemoveVariable  = this.handleRemoveVariable.bind(this);
    this.handleAddVariable     = this.handleAddVariable.bind(this);
    this.handleRedrawVariable  = this.handleRedrawVariable.bind(this);
    this.handleUpdateColor     = this.handleUpdateColor.bind(this);

  // Event handlers to handle clicking on a waveform label to select a signal
  labels.addEventListener(      'click', (e) => this.clicklabel(e));
  valueDisplay.addEventListener('click', (e) => this.clickValueDisplay(e));
  console.log('DEBUG WFSELECT labels listeners attached');

  // Dbl-click: handled exclusively via click detail>=2 (no separate dblclick listeners)
  // Right-click (context menu) debug logging
  labels.addEventListener('contextmenu', (e) => this.handleContextMenuLabels(e));
  valueDisplay.addEventListener('contextmenu', (e) => this.handleContextMenuValues(e));
    // resize handler to handle column resizing
    resize1.addEventListener("mousedown",   (e) => {this.handleResizeMousedown(e, resize1, 1);});
    resize2.addEventListener("mousedown",   (e) => {this.handleResizeMousedown(e, resize2, 2);});
    // click and drag handlers to rearrange the order of waveform signals
    labels.addEventListener('mousedown', (e) => {this.dragStart(e);});

    this.events.subscribe(ActionType.MarkerSet, this.handleMarkerSet);
    this.events.subscribe(ActionType.SignalSelect, this.handleSignalSelect);
    this.events.subscribe(ActionType.ReorderSignals, this.handleReorderSignals);
    this.events.subscribe(ActionType.AddVariable, this.handleAddVariable);
    this.events.subscribe(ActionType.RemoveVariable, this.handleRemoveVariable);
    this.events.subscribe(ActionType.RedrawVariable, this.handleRedrawVariable);
    this.events.subscribe(ActionType.UpdateColorTheme, this.handleUpdateColor);
  }
  private handleContextMenuLabels(event: MouseEvent) {
    const target = event.target as HTMLElement;
    const container = target?.closest('.waveform-label') as HTMLElement | null;
    const rowId = this.getRowIdFromElement(container);
    const ctxEl = (target?.closest('[data-vscode-context]') as HTMLElement | null) || container;
    const ctxRaw = ctxEl?.getAttribute('data-vscode-context');
    console.log('DEBUG_RMB labels contextmenu', {
      button: event.button,
      target: target?.className,
      rowId,
      dataContext: ctxRaw
    });
    // Do not preventDefault — allow VS Code to show the menu
  }

  private handleContextMenuValues(event: MouseEvent) {
    const target = event.target as HTMLElement;
    const container = target?.closest('.value-display-item') as HTMLElement | null;
    let rowId: number | null = null;
    if (container && container.id && container.id.startsWith('value-')) {
      const parsed = parseInt(container.id.split('-')[1]);
      rowId = isNaN(parsed) ? null : parsed;
    }
    const ctxEl = (target?.closest('[data-vscode-context]') as HTMLElement | null) || container;
    const ctxRaw = ctxEl?.getAttribute('data-vscode-context');
    console.log('DEBUG_RMB values contextmenu', {
      button: event.button,
      target: target?.className,
      rowId,
      dataContext: ctxRaw
    });
    // Do not preventDefault — allow VS Code to show the menu
  }

  renderLabelsPanels() {
    if (viewerState.isBatchRemoving) {
      try { console.log('DEBUG WFSELECT labels.renderLabelsPanels.SKIP (batch)'); } catch(_e){ /* noop */ }
      return;
    }
    try {
      console.log('DEBUG WFSELECT labels.renderLabelsPanels.start', {
        displayedSignals: viewerState.displayedSignals.length,
        displayedFlat: viewerState.displayedSignalsFlat.length,
        visibleFlat: viewerState.visibleSignalsFlat.length,
        stack: (new Error()).stack?.split('\n').slice(1,4)
      });
    } catch(_err) { /* noop */ }
    this.labelsList  = [];
    const transitions: string[] = [];
    this.labelsList.push('<svg id="drag-divider" style="top: 0px; display:none; pointer-events: none;"><line x1="0" y1="0" x2="100%" y2="0"></line></svg>');
    this.labelsList.push('<div id="draggable-cursor-tag" class="draggable-label" style="position: fixed; top: 0px; display:none; pointer-events: none;">clock</div>');
    viewerState.displayedSignals.forEach((rowId, index) => {
      const netlistData = dataManager.rowItems[rowId];
      this.labelsList.push(netlistData.createLabelElement());
      transitions.push(netlistData.createValueDisplayElement());
    });
    this.labels.innerHTML       = this.labelsList.join('');
    this.valueDisplay.innerHTML = transitions.join('');
    try {
      console.log('DEBUG WFSELECT labels.renderLabelsPanels.end', {
        labelsChildren: this.labels.childElementCount,
        valueChildren: this.valueDisplay.childElementCount
      });
    } catch(_err) { /* noop */ }
  }

  clickValueDisplay(event: any) {
    console.log('DIAG SELECT values.click', {
      shiftKey: !!event.shiftKey,
      ctrlKey: !!event.ctrlKey,
      metaKey: !!event.metaKey,
      button: event?.button,
      detail: event?.detail,
      targetClass: (event.target && event.target.className),
    });
    const clickedLabel = event.target.closest('.value-display-item') as HTMLElement | null;
    if (!clickedLabel) {return;}
    let rowId: number | null = null;
    if (clickedLabel.id && clickedLabel.id.startsWith('value-')) {
      const parsed = parseInt(clickedLabel.id.split('-')[1]);
      rowId = isNaN(parsed) ? null : parsed;
    }
    if (rowId === null) {return;}
    // Prefer native click count for reliable dblclick even if native dblclick event is lost
    if (!event.shiftKey && event.button === 0 && event.detail >= 2) {
  try { console.log('DEBUG_MOUSEDC values click detail>=2 -> open', { rowId, detail: event.detail }); } catch(_) { /* noop */ }
      this.openSourceForRowId(rowId);
      return;
    }
    // Use centralized selection helper to unify behavior across labels and waveform
    handleClickSelection(event, rowId);
  }

  clicklabel (event: any) {
    console.log('DIAG SELECT labels.click', {
      shiftKey: !!event.shiftKey,
      ctrlKey: !!event.ctrlKey,
      metaKey: !!event.metaKey,
      button: event.button,
      detail: event?.detail,
      targetClass: (event.target && event.target.className)
    });
    if (this.dragInProgress) {return;}
    if (this.renameActive) {return;}
    const clickedLabel = event.target.closest('.waveform-label');
    const rowId = this.getRowIdFromElement(clickedLabel);
    if (rowId === null || isNaN(rowId)) {return;}

    if (event.target.classList.contains('codicon-chevron-down') ||
        event.target.classList.contains('codicon-chevron-right')) {
        if (dataManager.rowItems[rowId] instanceof SignalGroup) {
          dataManager.rowItems[rowId].toggleCollapse();
        }
    } else {
      // Prefer native click count for reliable dblclick even if native dblclick event is lost
      if (!event.shiftKey && event.button === 0 && event.detail >= 2) {
  try { console.log('DEBUG_MOUSEDC labels click detail>=2 -> open', { rowId, detail: event.detail }); } catch(_) { /* noop */ }
        this.openSourceForRowId(rowId);
        return;
      }
      // Use centralized selection helper
      handleClickSelection(event, rowId);
    }
  }

  copyValueAtMarker(netlistId: NetlistId | undefined) {

    if (netlistId === undefined) {return;}
    const rowId = dataManager.netlistIdTable[netlistId];
    const value = this.valueAtMarker[rowId];
    if (value === undefined) {return;}
    const variableItem = dataManager.rowItems[rowId];
    if (!(variableItem instanceof VariableItem)) {return;}

    const formatString   = variableItem.valueFormat.formatString;
    const width          = variableItem.signalWidth;
    const bitVector      = value[value.length - 1];
    const formattedValue = formatString(bitVector, width, true);

    vscode.postMessage({command: 'copyToClipboard', text: formattedValue});
  }

  initializeDragHandler(event: MouseEvent | any) {
    this.labelsList        = Array.from(this.labels.querySelectorAll('.waveform-label'));
    this.pointerStartX     = event.clientX;
    this.pointerStartY     = event.clientY;
    this.scrollStartY      = this.labelsScroll.scrollTop;
    this.dragInProgress    = false;
    this.dragActive        = true;
  }

  setIdleItemsState(rowIdList: RowId[]) {
    // find all idle items and idle expanded dropus

    const draggableSignals: RowId[] = [];
    const draggableGroups: RowId[]  = [];
    this.draggableRows = [];

    const topLevelRowIds = dataManager.removeChildrenFromSignalList(rowIdList);
    topLevelRowIds.forEach((rowId) => {
      const signalItem = dataManager.rowItems[rowId];
      if (signalItem instanceof SignalGroup) {
        const children = signalItem.getFlattenedRowIdList(false, -1);
        const childGroups = children.filter((id) => dataManager.rowItems[id] instanceof SignalGroup);
        draggableGroups.push(...childGroups);
        this.draggableRows.push(...children);
      } else if (signalItem instanceof VariableItem) {
        draggableSignals.push(rowId);
        this.draggableRows.push(rowId);
      }
    });

    this.idleItems = [];
    this.idleGroups = [];
    //const draggableRows = draggableSignals.concat(draggableGroups);
    //let idleRowIds: number[] = [];
    //viewerState.displayedSignals.forEach((id: RowId) => {
    //  if (draggableRows.includes(id)) {return;}
    //  const signalItem = dataManager.rowItems[id];
    //  const children = signalItem.getFlattenedRowIdList(true, -1);
    //  const idleRows = children.filter((childId) => !draggableRows.includes(childId));
    //  idleRowIds = idleRowIds.concat(idleRows);
    //});
    this.draggableRows.forEach((id) => {
      const element = this.labels.querySelector(`#label-${id}`);
      if (element) {
        element.classList.remove('is-idle');
        this.idleItems.push(element);
      }
    });

    viewerState.visibleSignalsFlat.forEach((id: RowId) => {
      const signalItem = dataManager.rowItems[id];
      if (signalItem instanceof SignalGroup && !draggableGroups.includes(id)) {
        const element = this.labels.querySelector(`#label-${id}`);
        if (element) {
          const boundingBox = element.getBoundingClientRect();
          this.idleGroups.push({
            element: element,
            top: boundingBox.top + this.labels.scrollTop,
            bottom: boundingBox.bottom + this.labels.scrollTop,
            left: element.children[1].getBoundingClientRect().left,
          });
        }
      }
    });

    if (rowIdList.length > 1) {
      this.dragCursorText = rowIdList.length.toString();
    }
  }

  dragStart(event: any) {
    console.log('DEBUG WFSELECT dragStart', { button: event.button, target: (event.target && event.target.className) });
    // Right-click should not initiate drag or selection; let VS Code context menu handle it
    if (event.button === 2) { return; }
    if (event.button !== 0) { return; } // Only allow left mouse button drag
    if (this.renameActive) {return;} // Prevent drag if rename is active
    //event.preventDefault();
    
    this.draggableItem = event.target.closest('.waveform-label');
    if (!this.draggableItem) {return;}
    const rowId = parseInt(this.draggableItem.id.split('-')[1]);
    if (isNaN(rowId)) {return;}

    let rowIdList = [rowId];
    if (viewerState.selectedSignal.includes(rowId)) {
      rowIdList = viewerState.selectedSignal;
    }

    const signalItem = dataManager.rowItems[rowId];
    if (signalItem) {
      this.dragCursorText = signalItem.getLabelText();
    }

    this.draggableItem.classList.remove('is-idle');
    this.defaultDragDividerY = this.draggableItem.getBoundingClientRect().top + this.labelsScroll.scrollTop;
    clearTimeout(this.dragFreezeTimeout);
    this.dragFreeze = true;
    this.dragFreezeTimeout = setTimeout(() => {this.dragFreeze = false;}, 100);
    document.addEventListener('mousemove', this.dragMove);
    viewerState.mouseupEventType = 'rearrange';

    this.initializeDragHandler(event);
    this.setIdleItemsState(rowIdList);
  }

  dragStartExternal(event: MouseEvent | any) {

    this.initializeDragHandler(event);
    this.setIdleItemsState([]);
    this.defaultDragDividerY = this.labels.getBoundingClientRect().bottom + this.labelsScroll.scrollTop;
    viewerState.mouseupEventType = 'dragAndDrop';
  }

  setDraggableItemClasses() {
    if (!this.draggableItem) {return;}
    //this.draggableItem.classList.remove('is-idle');
    this.dragCursorTag = this.labels.querySelector('#draggable-cursor-tag');
    if (this.dragCursorTag) {
      this.dragCursorTag.style.display = 'block';
      this.dragCursorTag.innerHTML = `${this.dragCursorText}`;
    }
    this.draggableRows.forEach((rowId) => {
      const element = this.labels.querySelector(`#label-${rowId}`);
      if (element) {
        element.classList.add('is-draggable');
        element.classList.remove('is-idle');
      }
    });
  }

  setDragDivider() {
    this.dragDivider = this.labels.querySelector('#drag-divider');
    if (this.dragDivider) {this.dragDivider.style.display = 'block';}
    this.dragInProgress = true;
  }

  dragMove(event: MouseEvent | any) {

    if (!this.dragActive) {return;}
    if (!this.draggableItem) {return;}
    if (this.dragFreeze) {return;}
    if (!this.dragInProgress) {
      this.setDraggableItemClasses();
      this.setDragDivider();
    }

    if (this.dragCursorTag) {
      this.dragCursorTag.style.transform = `translate(${event.clientX}px, ${event.clientY}px)`;
    }

    this.updateIdleItemsStateAndPosition(event);
  }

  public dragMoveExternal(event: MouseEvent | any) {

    if (!this.dragInProgress) {
      this.dragStartExternal(event);
      this.setDragDivider();
    }

    this.updateIdleItemsStateAndPosition(event);
  }

  updateIdleItemsStateAndPosition(e: MouseEvent | any) {

    const labelsRect        = this.labels.getBoundingClientRect();
    const draggableItemY    = e.clientY;
    const scrollDelta       = this.scrollStartY - this.labelsScroll.scrollTop;
    const pointerY          = draggableItemY - scrollDelta;
    this.groupContainer     = null;
    let groupContainerBox: any = labelsRect;
    let smallestGroupBox: any = Infinity;
    let width = 0;

    // Reset all idle items and groups
    if (e.clientX <= labelsRect.right) {
      this.idleGroups.forEach((item: any) => {
        if (item.element.classList.contains('is-idle') === false) {return;}
        if (item.element.classList.contains('expanded-group') === false) {return;}
        item.element.style.backgroundColor = 'transparent';
        if (item.top < pointerY && item.bottom > pointerY && e.clientX > item.left) {
          const groupHeight = item.bottom - item.top;
          if (groupHeight < smallestGroupBox) {
            smallestGroupBox = groupHeight;
            this.groupContainer = item.element;
            width = item.left;
          }
        }
      });
    }

    let idleItems: any  = [];
    if (this.groupContainer) {
      this.groupContainer.style.backgroundColor = 'var(--vscode-list-dropBackground)';
      groupContainerBox = this.groupContainer.children[1].getBoundingClientRect();
      idleItems = Array.from(this.groupContainer.children[1].children);
      this.closestItem = null;
    } else {
      idleItems = Array.from(this.labels.children);
    }

    let breakFlag = false;
    this.indexOffset = 0;
    let dragDividerY: number | null = groupContainerBox.top - labelsRect.top;

    idleItems.forEach((item: any) => {
      if (breakFlag) {return;}
      if (!item.classList.contains('is-idle') && !item.classList.contains('is-draggable') ) {return;}
      const itemRect = item.getBoundingClientRect();
      if (draggableItemY >= itemRect.top && draggableItemY < itemRect.bottom) {
        dragDividerY = itemRect.top - labelsRect.top;
        const itemY = itemRect.top + itemRect.height / 2;
        if (draggableItemY >= itemY) {
          this.indexOffset = 1;
          dragDividerY += itemRect.height;
        }
        breakFlag = true;
        this.closestItem = item;
      }
    });

    if (!breakFlag) {
      if (draggableItemY >= groupContainerBox.bottom) {
        dragDividerY = groupContainerBox.bottom - labelsRect.top;
        this.closestItem = idleItems[idleItems.length - 1];
        this.indexOffset = 1;
      } else if (draggableItemY < groupContainerBox.top) {
        dragDividerY = groupContainerBox.top - labelsRect.top;
        this.closestItem = idleItems[0] || null;
        this.indexOffset = 0;
      } else {
        dragDividerY = (this.defaultDragDividerY - this.labelsScroll.scrollTop) - labelsRect.top;
        this.closestItem = this.draggableItem;
        this.indexOffset = 0;
      }
    }

    if (this.dragDivider !== null && dragDividerY !== null) {
      this.dragDivider.style.top = `${dragDividerY}px`;
      this.dragDivider.style.left = width + 'px';
    }
  }

  public getDropIndex() {
    const newGroupRowId = this.getRowIdFromElement(this.groupContainer);
    let newGroupId = 0;
    if (newGroupRowId !== null) {
      newGroupId = dataManager.groupIdTable.indexOf(newGroupRowId);
      if (newGroupId === -1) {
        newGroupId = 0; // If the group is not found, default to group 0
      }
    }

    let newIndex = 0;
    const closestItemRowId = this.getRowIdFromElement(this.closestItem);
    if (closestItemRowId === null || isNaN(closestItemRowId)) {
      newIndex = 0;
    } else{
      const dropItemIndex  = getIndexInGroup(closestItemRowId, newGroupId) || 0;
      newIndex = dropItemIndex + this.indexOffset;
    }

    console.log(`Drop at group ${newGroupId}, index ${newIndex}`);
    return {newGroupId, newIndex};
  }

  clearDragHandler() {
    this.idleItems.forEach((item: any) => {item.style = null;});
    this.idleItems      = [];
    this.idleGroups     = [];
    this.draggableRows  = [];
    this.labelsList     = [];
    this.dragInProgress = false;
    this.pointerStartX  = null;
    this.pointerStartY  = null;
    this.draggableItem  = null;
    this.dragActive     = false;
  if (this.dragDivider) { this.dragDivider.style.display = 'none'; }
  }

  public dragEndExternal(event: MouseEvent | KeyboardEvent | null, abort: boolean) {
    this.clearDragHandler();
    if (abort) {this.renderLabelsPanels();}
    return this.getDropIndex();
  }

  dragEnd(event: MouseEvent | KeyboardEvent | null, abort: boolean) {

    document.removeEventListener('mousemove', this.dragMove);
    this.dragActive = false;
    if (!this.dragInProgress) {return;}
    if (!this.draggableItem) {return;}
    if (event) {event.preventDefault();}

    const {newGroupId, newIndex} = this.getDropIndex();

    const draggableItemRowId = this.getRowIdFromElement(this.draggableItem);
    if (draggableItemRowId === null || isNaN(draggableItemRowId)) {
      throw new Error("Invalid draggable item row ID: " + draggableItemRowId);
    }
    let rowIdList: RowId[] = [draggableItemRowId];
    if (viewerState.selectedSignal.includes(draggableItemRowId)) {
      rowIdList = viewerState.selectedSignal;
    }

    this.clearDragHandler();
    clearTimeout(this.dragFreezeTimeout);

    if (!abort) {
      this.events.dispatch(ActionType.ReorderSignals, rowIdList, newGroupId, newIndex);
    } else {
      this.renderLabelsPanels();
    }
  }

  public showRenameInput(rowId: RowId) {
    this.dragEnd(null, true); // Abort any drag operation
    const signalItem = dataManager.rowItems[rowId];
    if (!(signalItem instanceof SignalGroup)) {return;}
    const labelElement = document.getElementById(`label-${rowId}`);
    if (!labelElement) {return;}
    const waveformRow = labelElement.querySelector('.waveform-row');
    if (!waveformRow) {return;}
    waveformRow.classList.remove('is-selected');
    
    // Get the current name for the textarea
    const currentName = signalItem.label || '';
    waveformRow.innerHTML = `<textarea id="rename-input-${rowId}" class="rename-input" autocorrect="off" autocapitalize="off" spellcheck="false" wrap="off">${htmlSafe(currentName)}</textarea>`;
    this.renameActive = true;

    // Focus the textarea and select all text
    const textarea = document.getElementById(`rename-input-${rowId}`) as HTMLTextAreaElement;
    const oldName  = signalItem.label;
    if (!textarea) {return;}
    textarea.focus();
    textarea.select();

    // Handle Enter key to submit rename
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const newNameInput = textarea.value.trim() || signalItem.label;
        const parentGroupId = getParentGroupId(rowId) || 0;
        const isTaken = dataManager.groupNameExists(newNameInput, parentGroupId);
        const newName = isTaken ? oldName : newNameInput;
        e.preventDefault();
        this.finishRename(signalItem, waveformRow, newName);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.finishRename(signalItem, waveformRow, oldName);
      }
    });

    // Handle blur to cancel rename
    textarea.addEventListener('blur', () => {this.finishRename(signalItem, waveformRow, oldName);});
  }

  private finishRename(signalItem: SignalGroup, waveformRow: Element, newName: string) {
    if (!this.renameActive) {return;}
    this.renameActive     = false;
    signalItem.label      = newName ? newName.trim() : signalItem.label;
    waveformRow.innerHTML = signalItem.createWaveformRowContent();
    if (viewerState.selectedSignal.includes(signalItem.rowId)) {
      waveformRow.classList.add('is-selected');
    }
    sendWebviewContext();
  }

  getRowIdFromElement(element: HTMLElement | null): RowId | null {
    if (!element) {return null;}
    const id = element.id.split('-')[1];
    if (!id) {return null;}
    const rowId = parseInt(id);
    if (isNaN(rowId)) {return null;}
    return rowId;
  }

  handleResizeMousedown(event: MouseEvent, element: HTMLElement, index: number) {
    this.resizeIndex   = index;
    this.resizeElement = element;
    //event.preventDefault();
    this.resizeElement.classList.remove('is-idle');
    this.resizeElement.classList.add('is-resizing');
    document.addEventListener("mousemove", this.resize, false);
    viewerState.mouseupEventType = 'resize';
  }

  // resize handler to handle resizing
  resize(e: MouseEvent) {
    const gridTemplateColumns = this.webview.style.gridTemplateColumns;
    const column1 = parseInt(gridTemplateColumns.split(' ')[0]);
    const column2 = parseInt(gridTemplateColumns.split(' ')[1]);
    const xPosition = Math.max(10, e.x);

    if (this.resizeIndex === 1) {
      this.webview.style.gridTemplateColumns = `${xPosition}px ${column2}px auto`;
      this.resize1.style.left = `${xPosition}px`;
      this.resize2.style.left = `${xPosition + column2}px`;
    } else if (this.resizeIndex === 2) {
      const newWidth    = Math.max(10, xPosition - column1);
      const newPosition = Math.max(10 + column1, xPosition);
      this.webview.style.gridTemplateColumns = `${column1}px ${newWidth}px auto`;
      this.resize2.style.left = `${newPosition}px`;
    }
  }

  handleAddVariable(rowIdList: RowId[], updateFlag: boolean) {
    this.renderLabelsPanels();
  }

  handleRemoveVariable(rowId: any, recursive: boolean) {
    this.renderLabelsPanels();
  }

  handleReorderSignals(rowIdList: number[], newGroupId: number, newIndex: number) {
    this.renderLabelsPanels();
  }

  handleMarkerSet(time: number, markerType: number) {

    if (time > viewport.timeStop || time < 0) {return;}

    if (markerType === 0) {
      viewerState.displayedSignalsFlat.forEach((rowId) => {
        const signalItem = dataManager.rowItems[rowId];
        this.valueAtMarker[rowId] = signalItem.getValueAtTime(time);
      });

      this.renderLabelsPanels();
    }
  }

  selectRowId(rowId: RowId, isSelected: boolean) {
    const signalItem = dataManager.rowItems[rowId];
    if (!signalItem) {return;}
    signalItem.isSelected = isSelected;
    //const labelElement = signalItem.labelElement;
    //const valueDisplayElement = signalItem.valueDisplayElement;
    //if (!labelElement) {return;}
    //if (!valueDisplayElement) {return;}
    //if (isSelected) {
    //  labelElement.children[0].classList.add('is-selected');
    //  valueDisplayElement.classList.add('is-selected');
    //} else {
    //  labelElement.children[0].classList.remove('is-selected');
    //  valueDisplayElement.classList.remove('is-selected');
    //}
  }

  handleSignalSelect(rowIdList: RowId[], lastRowId: RowId | null) {

    this.dragActive = false;
    if (this.dragDivider) {this.dragDivider.style.display = 'none';}
    if (rowIdList.length === 0) {return;}

    // Update selection visuals and state; use displayedSignalsFlat to clear highlights
    viewerState.selectedSignal = rowIdList;
    viewerState.selectedSignals = rowIdList;
    viewerState.lastSelectedSignal = lastRowId;
    viewerState.selectedSignalIndex = (lastRowId !== null)
      ? viewerState.visibleSignalsFlat.findIndex((signal) => signal === lastRowId)
      : null;
    console.log('DIAG SELECT labels.handleSignalSelect', {
      lastRowId,
      selectedSignalIndex: viewerState.selectedSignalIndex,
      selectedSignals: viewerState.selectedSignals,
      selectionAnchor: viewerState.selectionAnchor
    });

  if (this.dragDivider) { this.dragDivider.style.display = 'none'; }

    console.log('DIAG SELECT labels.clearingSelections', { displayedFlatLen: viewerState.displayedSignalsFlat.length });
    viewerState.displayedSignalsFlat.forEach((rowId) => {
      this.selectRowId(rowId, false);
    });

    console.log('DIAG SELECT labels.applyingSelections', { count: rowIdList.length, rowIdList });
    rowIdList.forEach((rowId) => {
      this.selectRowId(rowId, true);
    });
    viewerState.lastSelectedSignal = lastRowId;
    // Always re-render on selection to keep labels/values in sync
    this.renderLabelsPanels();
  }

  handleRedrawVariable(rowId: RowId) {
    this.renderLabelsPanels();
  }

  handleUpdateColor() {
    this.renderLabelsPanels();
  }

  private handleOpenSourceFromLabels(event: MouseEvent) {
    const clickedLabel = (event.target as HTMLElement)?.closest('.waveform-label') as HTMLElement | null;
    const rowId = this.getRowIdFromElement(clickedLabel);
    if (rowId === null || isNaN(rowId)) {return;}
    console.log('DEBUG MOUSEDC labels dblclick rowId=', rowId);
    this.openSourceForRowId(rowId);
  }

  private handleOpenSourceFromValues(event: MouseEvent) {
    const clicked = (event.target as HTMLElement)?.closest('.value-display-item') as HTMLElement | null;
    if (!clicked) {return;}
    const labelsList = Array.from(this.valueDisplay.querySelectorAll('.value-display-item'));
    const itemIndex  = labelsList.indexOf(clicked);
    if (itemIndex === -1) {return;}
    const rowId = viewerState.displayedSignals[itemIndex];
    if (rowId === null || isNaN(rowId)) {return;}
    console.log('DEBUG MOUSEDC values dblclick rowId=', rowId);
    this.openSourceForRowId(rowId);
  }

  private openSourceForRowId(rowId: RowId) {
    const item = dataManager.rowItems[rowId];
    if (!(item instanceof VariableItem)) {return;}
    let instancePath = item.signalName;
    if (item.scopePath && item.scopePath !== '') {instancePath = item.scopePath + '.' + item.signalName;}
    console.log('DEBUG MOUSEDC openSourceForRowId instancePath=', instancePath, 'uri=', viewerState.uri);
    vscode.postMessage({
      command: 'executeCommand',
      commandName: 'vaporview.openSource',
      args: { instancePath, uri: viewerState.uri }
    });
  }
}
