import { viewport, viewerState, dataManager, getChildrenByGroupId, getIndexInGroup, handleClickSelection, rowHandler, vscodeWrapper, styles, dragController, events} from './vaporview';
import { ActionType, type EventHandler } from './event_handler';
import { ValueFormat } from './value_format';
import { getParentGroupId } from './vaporview';
import { SignalGroup, NetlistVariable, SignalItem, RowItem, htmlSafe, CustomVariable, SignalSeparator } from './signal_item';
import { NetlistId, SignalId, type RowId, EnumData, EnumEntry, StateChangeType, NetlistVariableContext } from '../common/types';

interface IdleGroupEntry {
  element: HTMLElement;
  top: number;
  bottom: number;
  left: number;
}

export class LabelsPanels {

  resizeElement: HTMLElement | null = null;
  events: EventHandler;

  webview: HTMLElement;
  labels: HTMLElement;
  valueDisplay: HTMLElement;
  labelsScroll: HTMLElement;
  valuesScroll: HTMLElement;
  resize1: HTMLElement;
  resize2: HTMLElement;

  // drag handler variables
  dragDivider: HTMLElement | null   = null;
  dragCursorTag: HTMLElement | null = null;
  dragCursorText: string            = "";
  labelsList: string[]              = [];
  idleItems: Element[]              = [];
  idleGroups: IdleGroupEntry[]      = [];
  draggableRows: RowId[]            = [];
  draggableItem: HTMLElement | null = null;
  closestItem: HTMLElement | null   = null;
  groupContainer: HTMLElement | null = null;
  indexOffset: number               = 0;
  pointerStartX: number | null      = null;
  pointerStartY: number | null      = null;
  scrollStartY: number | null       = null;
  resizeIndex: number | null        = null;
  defaultDragDividerY: number       = 0;
  dragActive: boolean               = false;
  dragInProgress: boolean           = false;
  dragEndedAt: number               = 0;
  dragFreeze: boolean               = true;
  dragFreezeTimeout: ReturnType<typeof setTimeout> | null = null;

  renameActive: boolean             = false;
  signalFilterText: string          = '';
  filteredOutRows: Set<RowId>       = new Set();
  valueAtMarker: Record<number, string[]> = {};
  lastClickedSignal: RowId | null   = null;
  lastClickedTime: number           = 0;

  constructor(events: EventHandler) {
    this.events = events;

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
    //labels.addEventListener(      'click', (e) => this.clickLabel(e));
    //valueDisplay.addEventListener('click', (e) => this.clickValueDisplay(e));
    labelsScroll.addEventListener('click', (e) => this.clickLabel(e));
    valuesScroll.addEventListener('click', (e) => this.clickValueDisplay(e));
    // Waveform-pane signal filter: hide displayed signals whose name doesn't match.
    const signalFilter = document.getElementById('signal-filter') as HTMLInputElement | null;
    if (signalFilter) {
      signalFilter.addEventListener('input', () => {
        this.signalFilterText = signalFilter.value;
        this.applyRowFilter();
        // Re-render waveforms so virtualization bounds skip the now-hidden rows.
        viewport.renderAllWaveforms(false);
      });
    }
    // resize handler to handle column resizing
    resize1.addEventListener("mousedown",   (e) => {this.handleResizeMousedown(e, resize1, 1);});
    resize2.addEventListener("mousedown",   (e) => {this.handleResizeMousedown(e, resize2, 2);});
    // click and drag handlers to rearrange the order of waveform signals
    labels.addEventListener('mousedown', (e) => {this.dragStart(e);});
    // Abort an in-progress external drag if the pointer leaves the webview or the
    // native drag ends without a drop inside us (avoids a stale drop divider).
    this.webview.addEventListener('dragleave', (e) => {this.handleExternalDragLeave(e);});
    this.webview.addEventListener('dragend',   (e) => {if (dragController.isActive) {dragController.cancel(e);}});

    this.events.subscribe(ActionType.MarkerSet, this.handleMarkerSet);
    this.events.subscribe(ActionType.SignalSelect, this.handleSignalSelect);
    this.events.subscribe(ActionType.ReorderSignals, this.handleReorderSignals);
    this.events.subscribe(ActionType.AddVariable, this.handleAddVariable);
    this.events.subscribe(ActionType.RemoveVariable, this.handleRemoveVariable);
    this.events.subscribe(ActionType.RedrawVariable, this.handleRedrawVariable);
    this.events.subscribe(ActionType.UpdateColorTheme, this.handleUpdateColor);
  }

  renderLabelsPanels() {
    if (this.events.isBatchMode) {return;}
    this.labelsList  = [];
    this.labelsList.push('<svg id="drag-divider" style="top: 0px; display:none; pointer-events: none;"><line x1="0" y1="0" x2="100%" y2="0"></line></svg>');
    this.labelsList.push('<div id="draggable-cursor-tag" class="draggable-label" style="position: fixed; top: 0px; display:none; pointer-events: none;"> </div>');
    viewerState.displayedSignals.forEach((rowId, index) => {
      const netlistData = rowHandler.rowItems[rowId];
      this.labelsList.push(netlistData.createLabelElement());
    });
    this.labels.innerHTML = this.labelsList.join('');
    this.applyRowFilter();
  }

  renderValueDisplay() {
    const transitions: string[] = [];
    viewerState.displayedSignals.forEach((rowId, index) => {
      const netlistData = rowHandler.rowItems[rowId];
      transitions.push(netlistData.createValueDisplayElement());
    });
    this.valueDisplay.innerHTML = transitions.join('');
    this.applyRowFilter();
  }

  // Hide displayed signals whose name doesn't match the filter text. Applied across
  // the three synced columns (labels / values / waveforms) so rows stay aligned. A
  // group stays visible if its own name matches or any descendant matches. Re-applied
  // after every label/value/waveform render (re-render recreates the DOM).
  public applyRowFilter() {
    const q = this.signalFilterText.trim().toLowerCase();
    const setHidden = (rowId: RowId, hidden: boolean) => {
      if (hidden) {this.filteredOutRows.add(rowId);} else {this.filteredOutRows.delete(rowId);}
      const l = this.labels.querySelector(`#label-${rowId}`);
      const v = this.valueDisplay.querySelector(`#value-${rowId}`);
      const w = document.getElementById(`waveform-${rowId}`);
      if (l) {l.classList.toggle('filtered-out', hidden);}
      if (v) {v.classList.toggle('filtered-out', hidden);}
      if (w) {w.classList.toggle('filtered-out', hidden);}
    };

    if (q === '') {
      this.filteredOutRows.clear();
      viewerState.displayedSignalsFlat.forEach((rowId) => setHidden(rowId, false));
      return;
    }

    const nameOf = (rowId: RowId): string => {
      const item = rowHandler.rowItems[rowId];
      if (item instanceof NetlistVariable) {
        return [...(item.scopePath || []), item.signalName].join('.');
      }
      if (item instanceof CustomVariable) {return (item as any).name ?? '';}
      if (item instanceof SignalGroup) {return item.label ?? '';}
      return '';
    };

    // Returns whether the row (and hence its subtree) is visible under the filter.
    const decide = (rowId: RowId): boolean => {
      const item = rowHandler.rowItems[rowId];
      if (item instanceof SignalGroup) {
        let anyChild = false;
        item.children.forEach((childRowId) => { if (decide(childRowId)) {anyChild = true;} });
        const visible = anyChild || (item.label ?? '').toLowerCase().includes(q);
        setHidden(rowId, !visible);
        return visible;
      }
      const visible = nameOf(rowId).toLowerCase().includes(q);
      setHidden(rowId, !visible);
      return visible;
    };

    viewerState.displayedSignals.forEach((rowId) => decide(rowId));
  }

  clickValueDisplay(event: MouseEvent) {
    const labelsList   = Array.from(this.valueDisplay.querySelectorAll('.value-display-item'));
    const clickedLabel = (event.target as HTMLElement)?.closest('.value-display-item') ?? null;
    const itemIndex    = clickedLabel ? labelsList.indexOf(clickedLabel) : -1;
    if (itemIndex === -1) {
      rowHandler.deselectAllSignals();
      return;
    }
    const rowId = viewerState.displayedSignals[itemIndex];
    //this.events.dispatch(ActionType.SignalSelect, [rowId], rowId);
    handleClickSelection(event, rowId);
  }

  clickLabel(event: MouseEvent) {
    if (this.dragInProgress) {return;}
    if (Date.now() - this.dragEndedAt < 250) {return;} // click synthesized by a finished drag
    if (this.renameActive) {return;}
    const clickedLabel = (event.target as HTMLElement)?.closest('.waveform-label') as HTMLElement | null;
    const rowId = this.getRowIdFromElement(clickedLabel);
    if (rowId === null || isNaN(rowId)) {
      rowHandler.deselectAllSignals();
      return;
    }

    const target = event.target as HTMLElement;
    if (target.closest('.chevron-icon')) {
        if (rowHandler.rowItems[rowId] instanceof SignalGroup) {
          rowHandler.rowItems[rowId].toggleCollapse();
          vscodeWrapper.sendWebviewContext(StateChangeType.User);
        }
    } else {
      //this.events.dispatch(ActionType.SignalSelect, [rowId], rowId);
      handleClickSelection(event, rowId);
      this.doubleClickLabel(rowId);
    }
  }

  doubleClickLabel(rowId: RowId) {
    const time = Date.now();
    if (time - this.lastClickedTime < 300 && rowId === this.lastClickedSignal) {
      this.lastClickedSignal = null;
      this.lastClickedTime   = 0;
      const rowItem          = rowHandler.rowItems[rowId];
      if (rowItem instanceof NetlistVariable) {
        // Emit a double-click event; the extension host resolves the signal to
        // its RTL source (KDB or background source index) and opens it.
        const scopePath = rowItem.scopePath ?? [];
        vscodeWrapper.emitDoubleClickSignalEvent({
          uri: viewerState.uri?.toString() || "",
          netlistId: rowItem.netlistId,
          scopePath: scopePath,
          signalName: rowItem.signalName,
          instancePath: [...scopePath, rowItem.signalName].join('.'),
        });
      }
      return;
    }
    this.lastClickedSignal = rowId;
    this.lastClickedTime   = time;
  }

  copyValueAtMarker(rowId: RowId | undefined) {

    if (rowId === undefined) {return;}
    const value = this.valueAtMarker[rowId];
    if (value === undefined) {return;}
    const variableItem = rowHandler.rowItems[rowId];
    if (!(variableItem instanceof NetlistVariable) && !(variableItem instanceof CustomVariable)) {return;}

    const formatString   = variableItem.valueFormat.formatString;
    const width          = variableItem.signalWidth;
    const bitVector      = value[value.length - 1];
    const formattedValue = formatString(bitVector, width, true);

    vscodeWrapper.copyToClipboard(formattedValue);
  }

  initializeDragHandler(event: MouseEvent) {
    this.labelsList        = Array.from(this.labels.querySelectorAll('.waveform-label')).map((element) => element.outerHTML);
    this.pointerStartX     = event.clientX;
    this.pointerStartY     = event.clientY;
    this.scrollStartY      = this.labelsScroll.scrollTop;
    this.dragInProgress    = false;
    this.dragActive        = true;
  }

  setIdleItemsState(rowIdList: RowId[]) {
    // find all idle items and idle expanded groups

    const draggableSignals: RowId[] = [];
    const draggableGroups: RowId[]  = [];
    this.draggableRows = [];

    const topLevelRowIds = rowHandler.removeChildrenFromSignalList(rowIdList);
    topLevelRowIds.forEach((rowId) => {
      const signalItem = rowHandler.rowItems[rowId];
      if (signalItem instanceof SignalGroup) {
        const children = signalItem.getFlattenedRowIdList(false, -1);
        const childGroups = children.filter((id) => rowHandler.rowItems[id] instanceof SignalGroup);
        draggableGroups.push(...childGroups);
        this.draggableRows.push(...children);
      } else if (signalItem instanceof NetlistVariable || signalItem instanceof CustomVariable || signalItem instanceof SignalSeparator) {
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
      const signalItem = rowHandler.rowItems[id];
      if (signalItem instanceof SignalGroup && !draggableGroups.includes(id)) {
        const element = this.labels.querySelector(`#label-${id}`) as HTMLElement | null;
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

  dragStart(event: MouseEvent) {
    if (event.button !== 0) {return;} // Only allow left mouse button drag
    if (this.renameActive) {return;} // Prevent drag if rename is active
    //event.preventDefault();
    
    this.draggableItem = (event.target as HTMLElement)?.closest('.waveform-label') as HTMLElement | null;
    if (!this.draggableItem) {return;}
    const rowId = parseInt(this.draggableItem.id.split('-')[1]);
    if (isNaN(rowId)) {return;}

    let rowIdList = [rowId];
    if (viewerState.selectedSignal.includes(rowId)) {
      rowIdList = viewerState.selectedSignal;
    }

    const signalItem = rowHandler.rowItems[rowId];
    if (signalItem) {
      this.dragCursorText = signalItem.getLabelText();
    }

    this.draggableItem.classList.remove('is-idle');
    this.defaultDragDividerY = this.draggableItem.getBoundingClientRect().top + this.labelsScroll.scrollTop;
    if (this.dragFreezeTimeout) { clearTimeout(this.dragFreezeTimeout); }
    this.dragFreeze = true;
    this.dragFreezeTimeout = setTimeout(() => {this.dragFreeze = false;}, 100);

    this.initializeDragHandler(event);
    this.setIdleItemsState(rowIdList);

    dragController.begin(event, {
      kind: 'pointer',
      focusOnStart: true,
      onMove: (e) => this.dragMove(e),
      onEnd:  (e, abort) => this.dragEnd(e, abort),
    });
  }

  dragStartExternal(event: MouseEvent | DragEvent) {

    const types = (typeof DragEvent !== 'undefined' && event instanceof DragEvent && event.dataTransfer)
      ? Array.from(event.dataTransfer.types || []) : [];
    vscodeWrapper.outputDndLog(`dragStartExternal: external drag entered webview, dataTransfer.types=[${types.join(', ')}]`);

    this.initializeDragHandler(event);
    this.setIdleItemsState([]);
    this.defaultDragDividerY = this.labels.getBoundingClientRect().bottom + this.labelsScroll.scrollTop;

    dragController.begin(event, {
      kind: 'external',
      onMove: (e) => this.updateIdleItemsStateAndPosition(e),
      onEnd:  (e, abort) => {this.dragEndExternal(e, abort);},
    });
  }

  setDraggableItemClasses() {
    if (!this.draggableItem) {return;}
    //this.draggableItem.classList.remove('is-idle');
    this.dragCursorTag = this.labels.querySelector('#draggable-cursor-tag');
    if (this.dragCursorTag) {
      this.dragCursorTag.style.display = 'flex';
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

  dragMove(event: MouseEvent | DragEvent) {

    if (!this.dragActive) {return;}
    if (!this.draggableItem) {return;}
    if (this.dragFreeze) {return;}
    if (!this.dragInProgress) {
      this.setDraggableItemClasses();
      this.setDragDivider();
    }

    if (this.dragCursorTag) {
      this.dragCursorTag.style.transform = `translate(${event.clientX + 3}px, ${event.clientY}px)`;
    }

    this.updateIdleItemsStateAndPosition(event);
  }

  public dragMoveExternal(event: MouseEvent | DragEvent) {

    // HTML5 drag-and-drop: the `drop` event fires ONLY if the `dragover` handler calls
    // preventDefault() (and the element is thereby marked a valid drop target). Without
    // it, external drops silently no-op on strict platforms (Windows/Chromium) even
    // though they may appear to work elsewhere. This is the dragover handler, so make
    // the webview a valid drop target for drags coming from the netlist tree / editors.
    if (typeof DragEvent !== 'undefined' && event instanceof DragEvent) {
      event.preventDefault();
      if (event.dataTransfer) {event.dataTransfer.dropEffect = 'copy';}
    }

    if (!this.dragInProgress) {
      this.dragStartExternal(event);
      this.setDragDivider();
    }

    this.updateIdleItemsStateAndPosition(event);
  }

  updateIdleItemsStateAndPosition(e: MouseEvent | DragEvent) {

    const labelsRect        = this.labels.getBoundingClientRect();
    const draggableItemY    = e.clientY;
    const scrollDelta       = (this.scrollStartY ?? 0) - this.labelsScroll.scrollTop;
    const pointerY          = draggableItemY - scrollDelta;
    this.groupContainer     = null;
    let groupContainerBox: DOMRect = labelsRect;
    let smallestGroupBox: number = Infinity;
    let width = 0;

    // Reset all idle items and groups
    if (e.clientX <= labelsRect.right) {
      this.idleGroups.forEach((item: IdleGroupEntry) => {
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

    let idleItems: Element[]  = [];
    // Re-read groupContainer since it may have been set in the forEach above
    const groupContainer = this.groupContainer as HTMLElement | null;
    if (groupContainer !== null) {
      groupContainer.style.backgroundColor = styles.dropBackgroundColor;
      groupContainerBox = groupContainer.children[1].getBoundingClientRect();
      idleItems = Array.from(groupContainer.children[1].children);
      this.closestItem = null;
    } else {
      idleItems = Array.from(this.labels.children);
    }

    let breakFlag = false;
    this.indexOffset = 0;
    let dragDividerY: number | null = groupContainerBox.top - labelsRect.top;

    idleItems.forEach((item: Element) => {
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
        this.closestItem = item as HTMLElement;
      }
    });

    if (!breakFlag) {
      // Only real signal/group rows are valid drop anchors — skip the drag-divider
      // and cursor-tag helper elements (which have no rowId).
      const realItems = idleItems.filter((it) =>
        it.classList.contains('is-idle') || it.classList.contains('is-draggable')) as HTMLElement[];
      if (draggableItemY >= groupContainerBox.bottom) {
        // Below the last row → append to the end.
        dragDividerY = groupContainerBox.bottom - labelsRect.top;
        this.closestItem = realItems[realItems.length - 1] || null;
        this.indexOffset = 1;
      } else if (draggableItemY < groupContainerBox.top) {
        dragDividerY = groupContainerBox.top - labelsRect.top;
        this.closestItem = realItems[0] || null;
        this.indexOffset = 0;
      } else if (this.draggableItem) {
        // Internal reorder with the pointer in a gap → keep near the dragged row.
        dragDividerY = (this.defaultDragDividerY - this.labelsScroll.scrollTop) - labelsRect.top;
        this.closestItem = this.draggableItem;
        this.indexOffset = 0;
      } else {
        // External add (no dragged row) with the pointer inside the list span but not
        // over a specific row → append to the end. Previously this fell through to a
        // null closestItem and inserted at index 0, so dropping below the list added
        // the signal at the TOP instead of the bottom.
        dragDividerY = groupContainerBox.bottom - labelsRect.top;
        this.closestItem = realItems[realItems.length - 1] || null;
        this.indexOffset = 1;
      }
    }

    // Highlight the target row for external (add-signal) drags so the user can see
    // where the dropped signal will land. (Internal reorders already show the divider.)
    this.setDropHighlight(this.draggableItem ? null : this.closestItem);

    if (this.dragDivider !== null && dragDividerY !== null) {
      this.dragDivider.style.top = `${dragDividerY}px`;
      this.dragDivider.style.left = width + 'px';
    }
  }

  private dropHighlightItem: HTMLElement | null = null;
  private setDropHighlight(item: HTMLElement | null) {
    if (this.dropHighlightItem === item) {return;}
    if (this.dropHighlightItem) {this.dropHighlightItem.classList.remove('drop-target-highlight');}
    this.dropHighlightItem = item;
    if (item) {item.classList.add('drop-target-highlight');}
  }

  public getDropIndex() {
    const newGroupRowId = this.getRowIdFromElement(this.groupContainer);
    let newGroupId = 0;
    if (newGroupRowId !== null) {
      newGroupId = rowHandler.groupIdTable.indexOf(newGroupRowId);
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

    return {newGroupId, newIndex};
  }

  clearDragHandler() {
    this.setDropHighlight(null);
    // The browser fires a `click` on the grabbed label AFTER mouseup — by
    // then dragInProgress is already false, so clickLabel can't tell it from
    // a real click; stamp the drag end so clickLabel can swallow it.
    if (this.dragInProgress) {
      this.dragEndedAt = Date.now();
    }
    this.idleItems.forEach((item) => {(item as HTMLElement).style.cssText = '';});
    this.idleItems      = [];
    this.idleGroups     = [];
    this.draggableRows  = [];
    this.labelsList     = [];
    this.dragInProgress = false;
    this.pointerStartX  = null;
    this.pointerStartY  = null;
    this.draggableItem  = null;
    this.dragActive     = false;
    if (this.dragDivider) {this.dragDivider.style.display = 'none';}
  }

  public dragEndExternal(event: MouseEvent | KeyboardEvent | null, abort: boolean) {
    this.clearDragHandler();
    if (abort) {
      this.renderLabelsPanels();
      this.renderValueDisplay();
    }
    return this.getDropIndex();
  }

  handleExternalDragLeave(event: DragEvent) {
    if (!dragController.isActive) {return;}
    const rect = this.webview.getBoundingClientRect();
    const outside = event.clientX < rect.left || event.clientX > rect.right ||
                    event.clientY < rect.top  || event.clientY > rect.bottom;
    if (outside) {dragController.cancel(event);}
  }

  dragEnd(event: MouseEvent | KeyboardEvent | null, abort: boolean) {

    this.dragActive = false;
    if (!this.dragInProgress) {return;}
    if (!this.draggableItem) {return;}
    if (event) {event.preventDefault();}

    const {newGroupId, newIndex} = this.getDropIndex();

    const draggableItemRowId = this.getRowIdFromElement(this.draggableItem);
    if (draggableItemRowId === null || isNaN(draggableItemRowId)) {
      throw new Error("Invalid draggable item row ID: " + draggableItemRowId);
    }
    let rowIdList = [draggableItemRowId];
    if (viewerState.selectedSignal.includes(draggableItemRowId)) {
      rowIdList = viewerState.selectedSignal;
    }
    //const oldGroupId = getParentGroupId(draggableItemRowId) || 0;
    //const oldIndex   = getIndexInGroup(draggableItemRowId, oldGroupId) || 0;

    this.clearDragHandler();
    if (this.dragFreezeTimeout) { clearTimeout(this.dragFreezeTimeout); }

    if (!abort) {
      this.events.reorderSignals(rowIdList, newGroupId, newIndex);
      //console.log('dragEnd');
      vscodeWrapper.sendWebviewContext(StateChangeType.User);
    } else {
      this.renderLabelsPanels();
      this.renderValueDisplay();
    }
  }

  public showRenameInput(rowId: RowId) {
    dragController.cancel(null); // Abort any drag operation
    const signalItem   = rowHandler.rowItems[rowId];
    const labelElement = document.getElementById(`label-${rowId}`);
    if (!labelElement) {return;}
    const waveformRow  = labelElement.querySelector('.waveform-row');
    if (!waveformRow) {return;}
    waveformRow.classList.remove('is-selected');

    // Get the current name for the textarea
    const currentName = signalItem.getLabelText() || '';
    waveformRow.innerHTML = `<textarea id="rename-input-${rowId}" class="rename-input" autocorrect="off" autocapitalize="off" spellcheck="false" wrap="off">${htmlSafe(currentName)}</textarea>`;
    this.renameActive = true;

    // Focus the textarea and select all text
    const textarea = document.getElementById(`rename-input-${rowId}`) as HTMLTextAreaElement;
    if (!textarea) {return;}
    textarea.focus();
    textarea.select();

    // Handle Enter key to submit rename
    // we need this event handler because the global keydown handler will return early
    // due to the renameActive flag
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.finishRename(rowId, waveformRow, textarea);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.cancelRename();
      }
    });

    // Handle blur to cancel rename
    textarea.addEventListener('blur', () => {this.cancelRename();});
  }

  public cancelRename() {
    this.renameActive = false;
    this.renderLabelsPanels();
  }

  private finishRename(rowId: RowId, waveformRow: Element, textarea: HTMLTextAreaElement) {
    const signalItem    = rowHandler.rowItems[rowId];
    const isSignalGroup = signalItem instanceof SignalGroup;
    const newNameInput  = textarea.value.trim() || signalItem.getLabelText();
    const parentGroupId = getParentGroupId(rowId) || 0;
    const isTaken = rowHandler.groupNameExists(newNameInput, parentGroupId) && isSignalGroup;
    const isEmpty = newNameInput.trim().length === 0;
    const renameValid = !isEmpty && !isTaken;

    if (!this.renameActive) {return;}
    this.renameActive = false;
    if (renameValid) {
      signalItem.setLabelText(newNameInput.trim());
    }
    waveformRow.innerHTML = signalItem.createWaveformRowContent();
    if (viewerState.selectedSignal.includes(rowId)) {
      waveformRow.classList.add('is-selected');
    }
    vscodeWrapper.sendWebviewContext(StateChangeType.User);
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
    this.resizeElement.classList.remove('is-idle');
    this.resizeElement.classList.add('is-resizing');

    dragController.begin(event, {
      kind: 'pointer',
      focusOnStart: true,
      onMove: (e) => this.resize(e),
      onEnd: () => {
        this.resizeElement?.classList.remove('is-resizing');
        this.resizeElement?.classList.add('is-idle');
        this.events.resize();
      },
    });
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
    this.renderValueDisplay();
  }

  handleRemoveVariable(rowId: RowId[], recursive: boolean) {
    this.renderLabelsPanels();
    this.renderValueDisplay();
  }

  handleReorderSignals(rowIdList: number[], newGroupId: number, newIndex: number) {
    this.renderLabelsPanels();
    this.renderValueDisplay();
  }

  handleMarkerSet(time: number, markerType: number, dragging: boolean) {

    if (time > viewport.timeStop || time < 0) {return;}

    if (markerType === 0) {
      viewerState.displayedSignalsFlat.forEach((rowId) => {
        const signalItem = rowHandler.rowItems[rowId];
        this.valueAtMarker[rowId] = signalItem.getValueAtTime(time);
      });

      this.renderValueDisplay();
    }
  }

  selectRowId(rowId: RowId, isSelected: boolean) {
    const signalItem = rowHandler.rowItems[rowId];
    if (!signalItem) {return;}
    signalItem.isSelected = isSelected;
  }

  handleSignalSelect(rowIdList: RowId[], lastRowId: RowId | null) {

    this.dragActive = false;
    if (this.dragDivider) {this.dragDivider.style.display = 'none';}
    //if (rowIdList.length === 0) {return;}

    // Clear EVERY row item, not just displayedSignalsFlat — restore/reorder
    // can leave that list stale, and the panels re-render from isSelected,
    // so a missed item stays highlighted forever (even after deselection).
    rowHandler.rowItems.forEach((item) => {
      if (item) {
        item.isSelected = false;
      }
    });

    rowIdList.forEach((rowId) => {
      this.selectRowId(rowId, true);
    });
    viewerState.lastSelectedSignal = lastRowId;
    this.renderLabelsPanels();
    this.renderValueDisplay();
  }

  handleRedrawVariable(rowId: RowId) {
    this.renderLabelsPanels();
    this.renderValueDisplay();
  }

  handleUpdateColor() {
    this.renderLabelsPanels();
    this.renderValueDisplay();
  }
}
