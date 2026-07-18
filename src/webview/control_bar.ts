import { EnumQueueEntry, SignalId, type RowId, StateChangeType } from '../common/types';
import { ActionType, type EventHandler } from './event_handler';
import { vscodeWrapper, viewerState, viewport, dataManager, rowHandler, config} from './vaporview';
import { CustomVariable, NetlistVariable } from './signal_item';

enum ButtonState {
  Disabled = 0,
  Enabled  = 1,
  Selected = 2
}

enum SearchState {
  Time  = 0,
  Value = 1
}

enum SelectedSignalWidth {
  None       = 0,
  SingleBit  = 1,
  MultiBit   = 2
}

export class ControlBar {
  private zoomInButton: HTMLElement;
  private zoomOutButton: HTMLElement;
  private zoomFitButton: HTMLElement;
  private prevNegedge: HTMLElement;
  private prevPosedge: HTMLElement;
  private nextNegedge: HTMLElement;
  private nextPosedge: HTMLElement;
  private prevEdge: HTMLElement;
  private nextEdge: HTMLElement;
  private timeEquals: HTMLElement;
  private valueEquals: HTMLElement;
  private valueEqualsSymbol: HTMLElement;
  private previousButton: HTMLElement;
  private nextButton: HTMLElement;
  private autoReload: HTMLInputElement;
  settings: HTMLElement;

  private searchContainer: HTMLElement;
  private searchBar: HTMLInputElement;
  private valueIconRef: HTMLElement;

  // Search handler variables
  searchState         = SearchState.Time;
  searchInFocus       = false;

  private events: EventHandler;

  parsedSearchValue: string | null = null;

  constructor(events: EventHandler) {
    this.events = events;

    this.zoomInButton  = document.getElementById('zoom-in-button')!;
    this.zoomOutButton = document.getElementById('zoom-out-button')!;
    this.zoomFitButton = document.getElementById('zoom-fit-button')!;
    this.prevNegedge   = document.getElementById('previous-negedge-button')!;
    this.prevPosedge   = document.getElementById('previous-posedge-button')!;
    this.nextNegedge   = document.getElementById('next-negedge-button')!;
    this.nextPosedge   = document.getElementById('next-posedge-button')!;
    this.prevEdge      = document.getElementById('previous-edge-button')!;
    this.nextEdge      = document.getElementById('next-edge-button')!;
    this.timeEquals    = document.getElementById('time-equals-button')!;
    this.valueEquals   = document.getElementById('value-equals-button')!;
    this.valueEqualsSymbol = document.getElementById('search-symbol')!;
    this.previousButton = document.getElementById('previous-button')!;
    this.nextButton    = document.getElementById('next-button')!;
    this.autoReload    = document.getElementById('autoReload') as HTMLInputElement;
    this.settings      = document.getElementById('settings-menu')!;
    this.searchContainer = document.getElementById('search-container')!;
    this.searchBar     = document.getElementById('search-bar') as HTMLInputElement;
    this.valueIconRef  = document.getElementById('value-icon-reference')!;

    if (this.zoomInButton === null || this.zoomOutButton === null || this.zoomFitButton === null || 
        this.prevNegedge === null || this.prevPosedge === null || this.nextNegedge === null || 
        this.nextPosedge === null || this.prevEdge === null || this.nextEdge === null || 
        this.timeEquals === null || this.valueEquals === null || this.previousButton === null ||
        this.nextButton === null || this.searchContainer === null || this.searchBar === null ||
        this.valueIconRef === null ||  this.valueEqualsSymbol === null || this.autoReload === null) {
      throw new Error("Could not find all required elements");
    }

    // Control bar button event handlers
    this.zoomInButton.addEventListener( 'click', () => {viewport.handleZoom(-1, (viewport.pseudoScrollLeft + viewport.halfViewerWidth) / viewport.zoomRatio, viewport.halfViewerWidth);});
    this.zoomOutButton.addEventListener('click', () => {viewport.handleZoom(1, (viewport.pseudoScrollLeft + viewport.halfViewerWidth) / viewport.zoomRatio, viewport.halfViewerWidth);});
    this.zoomFitButton.addEventListener('click', () => {viewport.animateZoomRange(0, viewport.timeStop);});
    this.prevNegedge.addEventListener(  'click', () => {this.goToNextTransition(0, -1, ['0']);});
    this.prevPosedge.addEventListener(  'click', () => {this.goToNextTransition(0, -1, ['1']);});
    this.nextNegedge.addEventListener(  'click', () => {this.goToNextTransition(0,  1, ['0']);});
    this.nextPosedge.addEventListener(  'click', () => {this.goToNextTransition(0,  1, ['1']);});
    this.prevEdge.addEventListener(     'click', () => {this.goToNextTransition(0, -1, []);});
    this.nextEdge.addEventListener(     'click', () => {this.goToNextTransition(0,  1, []);});
    this.autoReload.addEventListener(  'change', (e: Event) => {this.handleAutoReloadCheckbox(e);});

    // Search bar event handlers
    this.searchBar.addEventListener(     'focus', () => {this.handleSearchBarInFocus(true);});
    this.searchBar.addEventListener(      'blur', () => {this.handleSearchBarInFocus(false);});
    this.searchBar.addEventListener(   'keydown', (e: KeyboardEvent) => {this.handleSearchBarKeyDown(e);});
    this.searchBar.addEventListener(     'keyup', (e: KeyboardEvent) => {this.handleSearchBarEntry(e);});
    this.timeEquals.addEventListener(    'click', () => {this.handleSearchButtonSelect(0);});
    this.valueEquals.addEventListener(   'click', () => {this.handleSearchButtonSelect(1);});
    this.previousButton.addEventListener('click', () => {this.handleSearchGoTo(-1);});
    this.nextButton.addEventListener(    'click', () => {this.handleSearchGoTo(1);});

    // Settings menu
    this.settings.addEventListener(      'click', (e: MouseEvent) => {this.clickSettings(e);});

    this.setButtonState(this.previousButton, ButtonState.Disabled);
    this.updateNextEdgeButtons([]);

    this.handleSignalSelect = this.handleSignalSelect.bind(this);
    this.handleRedrawVariable = this.handleRedrawVariable.bind(this);
    this.handleMarkerSet = this.handleMarkerSet.bind(this);

    this.events.subscribe(ActionType.SignalSelect, this.handleSignalSelect);
    this.events.subscribe(ActionType.RedrawVariable, this.handleRedrawVariable);
    this.events.subscribe(ActionType.MarkerSet, this.handleMarkerSet);
  }

  goToNextTransition(markerType: number, direction: number, edge: string[]) {
    //console.log("Go to next transition: " + direction + ' ' + edge);
    let nearestTime = markerType === 0 ? viewerState.markerTime : viewerState.altMarkerTime;
    if (nearestTime === null) {return;}
    if (viewerState.selectedSignal.length === 0) {return;}

    const nextTransitionTime: number[] = [];
    viewerState.selectedSignal.forEach((rowId) => {
      if (nearestTime === null) {return;}
      const data  = rowHandler.rowItems[rowId];
      const time  = data.getNextEdge(nearestTime, direction, edge);
      if (time === null) {return;}
      nextTransitionTime.push(time);
    });

    if (nextTransitionTime.length === 0) {return;}

    if (direction === 1) {
      nearestTime = Math.min(...nextTransitionTime);
    } else {
      nearestTime = Math.max(...nextTransitionTime);
    }

    this.events.markerSet(nearestTime, markerType, false);
    //console.log('goToNextTransition');
    vscodeWrapper.sendWebviewContext(StateChangeType.User);
  }

  // Applies the `vaporview.scrollingMode` setting (and the palette commands). The old
  // Mouse/Touchpad/Auto toolbar buttons were removed; scroll mode is config-driven only.
  setScrollMode(mode: string) {
    config.autoTouchpadScrolling = mode === 'Auto';
    config.touchpadScrolling     = mode === 'Touchpad';
  }

  clickSettings(e: MouseEvent) {
    e.preventDefault();
    (e.target as HTMLElement).dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: e.clientX, clientY: e.clientY })
    );
    e.stopPropagation();
  }

  setButtonState(buttonId: HTMLElement, state: number) {
    if (state === ButtonState.Disabled) {
      buttonId.classList.remove('selected-button');
      buttonId.classList.add('disabled-button');
    } else if (state === ButtonState.Enabled) {
      buttonId.classList.remove('disabled-button');
      buttonId.classList.remove('selected-button');
    } else if (state === ButtonState.Selected) {
      buttonId.classList.remove('disabled-button');
      buttonId.classList.add('selected-button');
    }
  }

  setBinaryEdgeButtons(selectable: number) {
    this.setButtonState(this.prevNegedge, selectable);
    this.setButtonState(this.prevPosedge, selectable);
    this.setButtonState(this.nextNegedge, selectable);
    this.setButtonState(this.nextPosedge, selectable);
  }

  setBusEdgeButtons(selectable: number) {
    this.setButtonState(this.prevEdge, selectable);
    this.setButtonState(this.nextEdge, selectable);
  }

  updateNextEdgeButtons(rowIdList: RowId[]) {

    const width = this.getSelectedSignalWidths(rowIdList);

    if (width === SelectedSignalWidth.None) {
      this.setBinaryEdgeButtons(ButtonState.Disabled);
      this.setBusEdgeButtons(ButtonState.Disabled);
    } else if (width === SelectedSignalWidth.SingleBit) {
      this.setBinaryEdgeButtons(ButtonState.Enabled);
      this.setBusEdgeButtons(ButtonState.Enabled);
    } else {
      this.setBinaryEdgeButtons(ButtonState.Disabled);
      this.setBusEdgeButtons(ButtonState.Enabled);
    }
  }

  getSelectedSignalWidths(rowIdList: RowId[]) {
    let result = SelectedSignalWidth.None;
    const isSingleBit: boolean[] = [];
    rowIdList.forEach((rowId) => {
      const signalItem = rowHandler.rowItems[rowId];
      if (!(signalItem instanceof NetlistVariable) && !(signalItem instanceof CustomVariable)) {return;}
      isSingleBit.push(signalItem.signalWidth === 1);
    });
    const allSingleBit = isSingleBit.reduce((prev, curr) => {return prev && curr;}, true);

    if (allSingleBit && isSingleBit.length > 0) {
      result = SelectedSignalWidth.SingleBit;
    } else if (isSingleBit.length > 0) {
      result = SelectedSignalWidth.MultiBit;
    }
    return result;
  }

  defocusSearchBar() {
    this.searchBar.selectionStart = 0;
    this.searchBar.selectionEnd   = 0;
    this.searchBar.blur();
  }

  handleSearchButtonSelect(button: number) {
    this.handleSearchBarInFocus(true);
    this.searchState = button;
    if (this.searchState === SearchState.Time) {
      this.setButtonState(this.timeEquals, ButtonState.Selected);
      this.setButtonState(this.valueEquals, ButtonState.Enabled);
    } else if (this.searchState === SearchState.Value) {
      this.setButtonState(this.timeEquals, ButtonState.Enabled);
      this.setButtonState(this.valueEquals, ButtonState.Selected);
    }
    this.handleSearchBarEntry({key: 'none'});
  }

  checkValidTimeString(inputText: string) {
    if (inputText.match(/^[0-9]+$/)) {
      this.parsedSearchValue = inputText.replace(/,/g, '');
      return true;
    }
    else {return false;}
  }

  handleSearchBarKeyDown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      this.handleSearchGoTo(1);
      return;
    }
  }
  
  handleSearchBarEntry(event: KeyboardEvent | { key: string }) {
    const inputText  = this.searchBar.value;
    let inputValid   = true;
    this.parsedSearchValue = null;

    if (this.searchState === SearchState.Time) {
      // Go-to-time needs no selected signal — it just moves the marker.
      inputValid = this.checkValidTimeString(inputText);
    } else if (this.searchState === SearchState.Value) {
      // Value search needs exactly one variable selected (to know its format/data).
      inputValid = false;
      if (viewerState.selectedSignal.length === 1) {
        const rowItem = rowHandler.rowItems[viewerState.selectedSignal[0]];
        if (rowItem instanceof NetlistVariable || rowItem instanceof CustomVariable) {
          const format = rowItem.valueFormat;
          inputValid = format.checkValidSearch(inputText);
          if (inputValid) {this.parsedSearchValue = format.parseSearchValue(inputText);}
        }
      }
    }

    // Update UI accordingly
    if (inputValid || inputText === '') {
      this.searchContainer.classList.remove('is-invalid');
    } else {
      this.searchContainer.classList.add('is-invalid');
    }
  
    if (inputValid && inputText !== '') {
      this.setButtonState(this.previousButton, this.searchState);
      this.setButtonState(this.nextButton, ButtonState.Enabled);
    } else {
      this.setButtonState(this.previousButton, ButtonState.Disabled);
      this.setButtonState(this.nextButton, ButtonState.Disabled);
    }
  }
  
  handleSearchGoTo(direction: number) {
    if (this.parsedSearchValue === null) {return;}
    let updateState = false;

    // Go to a time value — no signal selection required.
    if (this.searchState === SearchState.Time) {
      if (direction === 1) {
        this.events.markerSet(parseInt(this.parsedSearchValue), 0, false);
        updateState = true;
      }
      if (updateState) {vscodeWrapper.sendWebviewContext(StateChangeType.User);}
      return;
    }

    // Value search — find the next/previous transition matching the entered value on
    // the selected signal.
    if (viewerState.selectedSignal.length !== 1) {return;}
    const startTime = viewerState.markerTime ?? 0;
    const rowItem = rowHandler.rowItems[viewerState.selectedSignal[0]];
    if (rowItem === undefined || !(rowItem instanceof NetlistVariable) && !(rowItem instanceof CustomVariable)) {return;}
    const data = rowItem.getWaveformData();
    if (data === undefined) {return;}
    const format   = rowItem.valueFormat;
    const checkSearchValue = format.checkSearchValue;

    const valueChangeData = data.valueChangeData;
    const formattedData   = data.formattedValues;
    if (!formattedData[format.id]) {return;}
    if (!formattedData[format.id].formatCached) {return;}
    if (!formattedData[format.id].values) {return;}
    const formattedValues = formattedData[format.id].values;
    let timeIndex = valueChangeData.findIndex(([t]) => {return t >= startTime;});
    // No transition at/after the marker → start from the last one when searching back.
    if (timeIndex === -1) {timeIndex = valueChangeData.length - 1;}
    let indexOffset = 0;

    if (direction === -1) {indexOffset = -1;}
    else if (viewerState.markerTime === valueChangeData[timeIndex]?.[0]) {indexOffset = 1;}

    for (let i = timeIndex + indexOffset; i >= 0 && i < valueChangeData.length; i += direction) {
      if (checkSearchValue(this.parsedSearchValue, valueChangeData[i][1], formattedValues[i])) {
        this.events.markerSet(valueChangeData[i][0], 0, false);
        updateState = true;
        break;
      }
    }
    if (updateState) {
      vscodeWrapper.sendWebviewContext(StateChangeType.User);
    }
  }

  setAutoReload(state: boolean) {
    viewerState.autoReload  = state;
    this.autoReload.checked = state;
  }

  handleAutoReloadCheckbox(event: Event) {
    viewerState.autoReload = (event.target as HTMLInputElement).checked;
    vscodeWrapper.sendWebviewContext(StateChangeType.None);
  }

  handleSearchBarInFocus(isFocused: boolean) {
    this.searchInFocus = isFocused;
    if (isFocused) {
      if (document.activeElement !== this.searchBar) {
        this.searchBar.focus();
      }
      if (this.searchContainer.classList.contains('is-focused')) {return;}
      this.searchContainer.classList.add('is-focused');
      this.handleSearchBarEntry({key: 'none'});
    } else {
      this.searchContainer.classList.remove('is-focused');
    }
  }

  handleSignalSelect(rowIdList: RowId[], lastSelected: RowId | null = null) {

    this.updateNextEdgeButtons(rowIdList);

    if (rowIdList.length !== 1) {return;}
    const signalItem = rowHandler.rowItems[rowIdList[0]];
    if (signalItem && (signalItem instanceof NetlistVariable || signalItem instanceof CustomVariable)) {
      this.valueEqualsSymbol.textContent = signalItem.valueFormat.symbolText;
    }
  }

  handleRedrawVariable(rowId: RowId) {
    const rowItem = rowHandler.rowItems[rowId];
    if (!(rowItem instanceof NetlistVariable) && !(rowItem instanceof CustomVariable)) {return;}
    if (rowId === viewerState.selectedSignal[0]) {
      this.valueEqualsSymbol.textContent = rowItem.valueFormat.symbolText;
    }
  }

  handleMarkerSet(time: number, markerType: number, dragging: boolean) {
    if (dragging) {return;}
    if (this.searchState === SearchState.Time) {
      this.searchBar.value = String(time);
      this.searchContainer.classList.remove('is-invalid');
    }
  }

}