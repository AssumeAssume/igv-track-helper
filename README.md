# IGV-Web Track Helper v0.4.0

An independent, lightweight userscript for selecting and **moving selected IGV tracks together**. All controls are in English. No keyboard shortcuts are added.

## Install or update

Open the existing **IGV-Web Track Helper** script in Tampermonkey, replace its complete contents with `igv-track-helper.user.js`, and save. Keep only one version enabled. Save or otherwise ensure you can restore your current IGV session before reloading the page: a page reload can reset manually loaded IGV tracks. Reload once to remove the old version's event listeners.

The script still matches the official IGV web app and:

```js
// @match        https://ondemand.hpc.kuleuven.be/*
```

Changing the compute node, proxied port or session path does not require editing the match. No helper is shown in other OnDemand applications unless an IGV track-selection interface is detected.

## Move a group of tracks

1. Enable **Select Tracks** in IGV.
2. Select two or more tracks. They do not need to be adjacent. Shift-click still selects a range.
3. Drag the **right-hand drag handle of any selected track**.
4. A badge shows the number of tracks being moved, and a blue insertion line shows the destination.
5. Release the mouse inside the same IGV track area. All selected tracks are gathered into a contiguous block, preserving their original relative order. Unselected tracks retain their relative order too.

The recognized native handle is:

```html
<div class="igv-track-drag-handle igv-track-drag-handle-color"></div>
```

No new move button or modifier key is needed. Tracks are committed to their new order **on mouse release**, not continuously during the preview. Hover near the top or bottom of the track area while dragging to scroll. Release outside that IGV's track area to cancel. Merely clicking a handle without dragging does not gather the tracks.

**Undo** reverses a completed group move; **Redo** reapplies it. Undo/Redo also continue to support selection changes. Track removal/loading clears obsolete history. An external/native reorder can invalidate order history; the helper checks for this before restoring it.

Dragging one selected track when it is the only selection, or dragging an unselected track's handle, continues to use IGV's native single-track drag. Ruler and ideogram rows are not moved into the data-track block.

## Simplified interface

Visible by default:

- **Select All · Invert · Clear All**
- **Undo · Redo · Copy Names**
- A selected/total counter and short drag hint

**Filter & select** is collapsed initially. Expand it for include/exclude name matching, optional Regex/Match case, track type and replace/add/remove selection actions. **Selected tracks**, or the counter, opens the selected-name list. The header remains draggable and collapsible; its position defaults to 8 px from the upper-right corner.

Removed completely: selection presets, save/load preset controls, preset import/export, and all Visible/Hidden/In viewport selection options. Existing v0.3 preset data in local storage is not read or changed. The previous toolbar-position storage key is retained for upgrade compatibility. The script only persists UI position/collapse settings; storage restrictions can make those settings temporary.

## How group ordering works

IGV renders track axes, data viewports, sample columns, scrollbars, drag handles and gear controls as parallel columns. Reordering only one DOM column would misalign the display.

The helper discovers a compatible IGV browser object through exposed browser globals, or through the existing IGV canvas draw-context back-reference (`canvas._data.viewport.trackView.browser`). One rendered canvas can reveal all the track views in its own browser. It does not read genomic feature payloads or image pixels.

A move updates the actual track order and calls that browser's **`reorderTracks()`**. It also emits IGV's `trackorderchanged` event. Undo records the previous track-object order and order fields. This keeps the order in the browser model and its rendered columns consistent, rather than making a cosmetic DOM-only move. Selection state is not changed by a group move. The order is part of the current session; save the session normally to retain it after reopening.

**Compatibility boundary:** this is a checked internal adapter, not a guaranteed public IGV multi-drag API. Future IGV builds can change the object layout. A completely unrendered view may not yet expose a canvas, unless its browser object is available globally. Selection tools do not require the sorting adapter. When a recognized multi-selected handle lacks a compatible adapter, the helper reports `Group drag unavailable` instead of silently starting a single-track move. No closed Shadow DOM, cross-origin frame or authentication boundary is bypassed.

Ordinary DOM, open Shadow DOM and accessible same-origin frames are supported. Each IGV instance is treated independently. Child-frame userscript injection still depends on the frame's URL matching the script and the browser/userscript manager's frame permissions.

## Local demo

Unzip the whole package and open `demo.html`. It uses synthetic tracks and a small native-shaped test double; **it is not the actual IGV library and does not load genomic data**. Use it to inspect the toolbar or practice group dragging. The synthetic columns are deliberately parallel to exercise the sorting adapter.

## Tests and scope of verification

`tests/results.json` records **23 passing offline Chromium checks**. The tests cover group gathering from non-adjacent tracks, upward/downward placement, synchronized parallel columns/model/session order, selection/order Undo and Redo, unsupported-adapter handling, failed-operation rollback, native single dragging, multiple instances, dynamic track changes, duplicate names, scrolling, open Shadow DOM, ordinary DOM, same-origin iframe dragging, and existing selection/filter/clipboard controls.

These checks use a **synthetic native-shaped IGV test double**, not a production IGV build. They do **not** establish that the script has been tested in your authenticated KU Leuven session, in Tampermonkey's actual runtime, or in other browsers. Screenshots are from that synthetic fixture.

To rerun with Python, Playwright and Chromium installed:

```bash
node --check igv-track-helper.user.js
python tests/test_browser.py
python tests/test_frames.py
```

Tests default to `/usr/bin/chromium`; change `executable_path` in the test files for another location. They mock storage/clipboard where needed for an offline page. The first test resets the report; the frame test appends its three checks.

## Privacy and sharing

The helper contains no network calls, analytics, external dependencies, uploads or broad `@match *://*/*` rule. It uses existing page objects and native selection events. **Copy Names** writes names to the clipboard only when requested. The userscript manager may perform its own update checks independently of this code.

Share `igv-track-helper.user.js` or this ZIP. A hosted `.user.js` raw file can be used for userscript-manager installation. To configure updates, add your own actual `@updateURL` and `@downloadURL` and increment `@version` on subsequent releases; no repository URL is fabricated in this package.

## References checked for the adapter

- [IGV-Web User Guide — selection and track movement](https://igv.org/doc/webapp/UserGuide/)
- [Official igv.js TrackView implementation](https://github.com/igvteam/igv.js/blob/master/js/trackView.js)
- [Official igv.js Browser ordering implementation](https://github.com/igvteam/igv.js/blob/master/js/browser.js)
- [Official igv.js TrackViewport canvas context](https://github.com/igvteam/igv.js/blob/master/js/trackViewport.js)

Inspected on 2026-10-01; the upstream `master` branch is mutable.

## License

MIT. Community utility, not an official IGV extension.
