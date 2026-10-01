# Changelog

## 0.4.0 — 2026-10-01

- Remove selection presets, preset import/export and all visibility-selection controls.
- Collapse Filter & select by default and reduce toolbar width to 352 px.
- Add drag-to-gather for two or more selected native track handles; no extra button or shortcut.
- Preserve within-selection and unselected relative order; preview an insertion line before committing.
- Use the IGV browser ordering model and native reorderTracks(), not DOM-only rearrangement.
- Include group moves in Undo/Redo, with exact prior order fields restored.
- Preserve native single dragging, pinned headers and untouched bottom-order sentinel tracks.
- Support drop cancellation, an inner-scroll/window-scroll edge-scrolling path and compatible-viewer checks.
- Use track-object identity for sorting, including duplicate names.
- Retain ordinary/open-shadow DOM and accessible same-origin iframe discovery.
- Keep the original userscript name/namespace and v3 UI settings key for upgrades.
- 23 passing offline Chromium checks against a synthetic test double; no production-session claim.
