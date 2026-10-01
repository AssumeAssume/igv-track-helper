// ==UserScript==
// @name         IGV-Web Track Helper
// @namespace    https://igv.org/
// @version      0.4.0
// @description  Select, filter and move selected IGV tracks together. Shift-click, undo/redo, clipboard and a movable English toolbar. No keyboard shortcuts.
// @author       Community utility
// @match        https://igv.org/app*
// @match        https://igv.org/web/app*
// @match        https://ondemand.hpc.kuleuven.be/*
// @run-at       document-idle
// @grant        none
// @license      MIT
// ==/UserScript==

/* Independent community helper, not an official IGV extension.
 * No dependencies, network requests, analytics, or keyboard handlers.
 * Selection changes use input.click(), so IGV receives its normal events.
 * Group drag uses the IGV browser object and reorderTracks(), never DOM-only
 * sorting. This internal adapter is checked at runtime and may need updates
 * for future IGV releases. Unknown file formats are not guessed.
 */
(() => {
  'use strict';
  const VERSION = '0.4.0';
  const KEY = '__IGV_TRACK_HELPER_V3__';
  const BOX = 'input[type="checkbox"][name="track-select"]';
  const HOST_ID = 'igv-track-helper-v3';
  const STORE = 'igv-track-helper:v3:';
  const MAX_HISTORY = 50;
  const ownControllers = new Set();

  // Re-installation of v0.3+ is idempotent. Old v0.1/v0.2 anonymous timers
  // cannot be removed safely: replace the old userscript and reload the page.
  try { document[KEY]?.dispose(); } catch (_) { /* detached document */ }

  function start(doc) {
    if (!doc || !doc.defaultView || !doc.documentElement || doc[KEY]) return;
    const win = doc.defaultView;
    let containingFrame = null;
    try { containingFrame = win.frameElement; } catch (_) { /* cross-origin parent */ }
    let disposed = false;
    let suppress = false;
    let scanning = false;
    let timer;
    let poll;
    let sweep = 0;
    let host;
    let ui;
    let active = null;
    let serial = 0;
    let message = 'Shift-click track boxes to select or clear a range.';
    const roots = new Map();
    const groups = new Map();
    const boxGroups = new WeakMap();
    const childDocs = new Set();
    const boundFrames = new WeakSet();
    const cleanups = [];
    const memory = new Map();
    let storageBlocked = false;
    let lastPointer = null;
    let trackDrag = null;
    let committingOrder = false;
    const knownBrowsers = new Set();
    let settings = read('settings', { top: 8, right: 8, collapsed: false });
    if (!settings || typeof settings !== 'object') settings = {};
    settings = {
      top: finite(settings.top, 8), right: finite(settings.right, 8),
      collapsed: settings.collapsed === true
    };

    function finite(x, fallback) { return typeof x === 'number' && Number.isFinite(x) ? Math.max(0, x) : fallback; }
    function read(key, fallback) {
      try {
        const raw = win.localStorage.getItem(STORE + key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch (_) { storageBlocked = true; return memory.get(key) ?? fallback; }
    }
    function write(key, value) {
      memory.set(key, value);
      try { win.localStorage.setItem(STORE + key, JSON.stringify(value)); }
      catch (_) { storageBlocked = true; }
    }
    function listen(target, type, fn, options) {
      target.addEventListener(type, fn, options);
      cleanups.push(() => target.removeEventListener(type, fn, options));
    }
    function parent(el) { return el?.parentElement || el?.getRootNode?.().host || null; }
    function safeText(x) { return typeof x === 'string' ? x.trim() : ''; }
    function ownChild(el, ancestor) {
      if (!el || !ancestor) return null;
      let n = el;
      while (n && n.parentElement !== ancestor) n = n.parentElement;
      return n;
    }
    function rendered(el, requireRect = true) {
      if (!el?.isConnected) return false;
      for (let n = el; n && n.nodeType === 1; n = parent(n)) {
        const css = win.getComputedStyle(n);
        if (n.hidden || css.display === 'none' || css.visibility === 'hidden' ||
            css.visibility === 'collapse' || Number(css.opacity) === 0) return false;
      }
      if (!requireRect) return true;
      const r = el.getBoundingClientRect();
      return el.getClientRects().length > 0 && r.width > 0 && r.height > 0;
    }

    // Discover only open shadow roots and same-origin, accessible frames.
    // Existing roots are cached; a periodic sweep catches attachShadow() on
    // an already-present host, which MutationObserver cannot observe itself.
    function discover(root) {
      if (!root?.querySelectorAll || (root.host && root.host.id === HOST_ID)) return;
      if (!roots.has(root)) {
        const observer = new win.MutationObserver(changes => {
          if (changes.every(c => c.target === host || host?.contains(c.target))) return;
          schedule();
        });
        observer.observe(root, { subtree: true, childList: true, characterData: true,
          attributes: true, attributeFilter: ['style', 'class', 'hidden', 'name', 'disabled', 'title', 'data-tracktype', 'data-track-type'] });
        roots.set(root, observer);
      }
      for (const el of root.querySelectorAll('*')) {
        if (el === host || el.id === HOST_ID) continue;
        if (el.shadowRoot) discover(el.shadowRoot);
        if (el.tagName === 'IFRAME') {
          const inspect = () => {
            try {
              const child = el.contentDocument;
              if (child && child !== doc && child.documentElement) {
                childDocs.add(child);
                start(child);
              }
            } catch (_) { /* cross-origin / sandbox: do not bypass */ }
          };
          if (!boundFrames.has(el)) { boundFrames.add(el); listen(el, 'load', inspect); }
          inspect();
        }
      }
    }
    function schedule() {
      if (!disposed && !timer) timer = win.setTimeout(() => { timer = null; refresh(); }, 100);
    }
    function trackObjects() {
      // Discover from known public globals, or from IGV's canvas draw-context
      // back-reference. One rendered canvas can locate the whole viewer.
      const map = new Map();
      const candidates = [...knownBrowsers];
      try {
        candidates.push(win.igv?.browser, win.igvBrowser, win.browser);
        if (Array.isArray(win.igv?.browsers)) candidates.push(...win.igv.browsers);
      } catch (_) { /* inaccessible realm */ }
      for (const root of roots.keys()) {
        for (const canvas of root.querySelectorAll('.igv-viewport canvas')) {
          try {
            const tv = canvas._data?.viewport?.trackView;
            if (tv?.browser) candidates.push(tv.browser);
          } catch (_) { /* inaccessible object: do not bypass */ }
        }
      }
      for (const b of new Set(candidates)) {
        if (!Array.isArray(b?.trackViews) || !b.columnContainer?.isConnected ||
            b.columnContainer.ownerDocument !== doc) { knownBrowsers.delete(b); continue; }
        knownBrowsers.add(b);
        for (const tv of b.trackViews) {
          try {
            const input = tv.trackSelectionContainer?.querySelector(BOX) || tv.axis?.querySelector(BOX);
            if (input && tv.track) map.set(input, tv.track);
          } catch (_) { /* stale view */ }
        }
      }
      return map;
    }
    function normalizeFormat(value) {
      const v = safeText(value).toLowerCase().replace(/^\./, '');
      const aliases = { bw: 'bigwig', bb: 'bigbed', bigwig: 'bigwig', bigbed: 'bigbed',
        bam: 'bam', cram: 'cram', vcf: 'vcf', bcf: 'bcf', bed: 'bed', bedgraph: 'bedgraph',
        wig: 'wig', gff: 'gff', gff3: 'gff3', gtf: 'gtf', bedpe: 'bedpe', narrowpeak: 'narrowpeak',
        broadpeak: 'broadpeak', seg: 'seg', tdf: 'tdf', biginteract: 'biginteract', interact: 'interact' };
      return aliases[v] || '';
    }
    function extension(value) {
      let s = typeof value === 'string' ? value : safeText(value?.name);
      if (!s || s.length > 20000) return '';
      s = s.split(/[?#]/, 1)[0].replace(/\.(gz|bgz|bgzf)$/i, '');
      return normalizeFormat(s.match(/\.([a-z0-9]+)$/i)?.[1]);
    }
    function category(type, format) {
      const t = safeText(type).toLowerCase();
      if (['bigwig', 'wig', 'bedgraph', 'tdf'].includes(format) || ['wig', 'quantitative', 'merged'].includes(t)) return 'quantitative';
      if (['bam', 'cram'].includes(format) || ['alignment', 'bam'].includes(t)) return 'alignment';
      if (['vcf', 'bcf'].includes(format) || ['variant', 'vcf'].includes(t)) return 'variant';
      if (['bedpe', 'interact', 'biginteract'].includes(format) || t === 'interaction') return 'interaction';
      if (['bed', 'bigbed', 'gff', 'gff3', 'gtf', 'narrowpeak', 'broadpeak'].includes(format) || ['annotation', 'feature'].includes(t)) return 'annotation';
      return t || 'unknown';
    }
    function descriptor(box, index, objects) {
      const axisColumn = box.closest('.igv-axis-column');
      const columnContainer = box.closest('.igv-column-container');
      const axisRow = ownChild(box, axisColumn);
      let viewport = null;
      if (axisRow && columnContainer) {
        // IGV uses parallel columns, not one enclosing div per track.
        // Include ruler/sequence rows in the positional mapping, otherwise
        // names shift by one or more tracks. Multi-locus columns repeat rows.
        const i = Array.from(axisColumn.children).indexOf(axisRow);
        const columns = Array.from(columnContainer.children).filter(el => el.classList.contains('igv-column'));
        for (const col of columns) {
          const rows = Array.from(col.children).filter(el => el.classList.contains('igv-viewport'));
          if (rows.length === axisColumn.children.length) { viewport = rows[i]; break; }
        }
      }
      const genericRow = box.closest('.igv-track-div, .igv-track, [data-track-name]');
      const row = viewport || genericRow || axisRow || box.parentElement;
      let track = objects.get(box);
      if (!track && viewport) {
        // Current igv.js stores its draw context on a rendered canvas. Read
        // only the associated track metadata; never read genomic features.
        for (const c of viewport.querySelectorAll('canvas')) {
          try { track = c._data?.viewport?.trackView?.track; } catch (_) { /* sandbox */ }
          if (track) break;
        }
      }
      const label = viewport?.querySelector('.igv-track-label') || genericRow?.querySelector('.igv-track-label');
      const name = safeText(label?.textContent) || safeText(genericRow?.dataset.trackName) ||
        safeText(box.dataset.trackName) || safeText(track?.name) || safeText(track?.config?.name);
      const cfg = track?.config || {};
      const type = safeText(track?.type) || safeText(axisRow?.dataset.tracktype) ||
        safeText(viewport?.dataset.trackType) || safeText(genericRow?.dataset.trackType);
      let format = normalizeFormat(track?.format) || normalizeFormat(cfg.format) ||
        normalizeFormat(viewport?.dataset.format) || normalizeFormat(genericRow?.dataset.format);
      let formatSource = format ? 'metadata' : '';
      if (!format) {
        for (const val of [cfg.filename, cfg.url, track?.url]) {
          format = extension(val);
          if (format) { formatSource = 'source filename'; break; }
        }
      }
      if (!format) { format = extension(name); if (format) formatSource = 'track-name suffix'; }
      let trackView = track?.trackView;
      if (!trackView) {
        for (const b of knownBrowsers) {
          trackView = b.trackViews.find(tv => tv.track === track && tv.axis === axisRow);
          if (trackView) break;
        }
      }
      let dragHandle = trackView?.dragHandle;
      if (!dragHandle && axisRow && columnContainer) {
        const dragColumn = columnContainer.querySelector('.igv-track-drag-column');
        if (dragColumn?.children.length === axisColumn.children.length) {
          dragHandle = dragColumn.children[Array.from(axisColumn.children).indexOf(axisRow)];
        }
      }
      return { box, row, trackView, dragHandle, name: name || `Unnamed track ${index + 1}`, nameKnown: !!name,
        type: category(type, format), format, formatSource,
        // Inspect the selection container rather than the input itself, so
        // a custom-styled hidden input can still be used correctly.
        modeOn: rendered(box.parentElement), enabled: !box.disabled };
    }
    function newGroup(scope) {
      return { scope, id: String(++serial), records: [], enabled: false,
        anchor: null, undo: [], redo: [], label: '', seen: false,
        filter: { include: '', exclude: '', regex: false, matchCase: false, type: '', action: 'replace' } };
    }
    function refresh(forceDiscovery = false) {
      if (disposed || scanning || trackDrag || committingOrder) return;
      if (containingFrame && !containingFrame.isConnected) { dispose(); return; }
      scanning = true;
      try {
        if (forceDiscovery || !roots.size || Date.now() - sweep > 3500) { discover(doc); sweep = Date.now(); }
        for (const child of childDocs) {
          try { if (!child.defaultView || !child.defaultView.frameElement?.isConnected) { child[KEY]?.dispose(); childDocs.delete(child); } }
          catch (_) { childDocs.delete(child); }
        }
        for (const [root, observer] of roots) {
          if (root.host && !root.host.isConnected) { observer.disconnect(); roots.delete(root); }
        }
        const objects = trackObjects();
        const inventory = new Map();
        for (const root of roots.keys()) {
          for (const box of root.querySelectorAll(BOX)) {
            const scope = box.closest('.igv-container') || box.closest('.igv-root-div') || root;
            // Avoid similarly named controls elsewhere on OnDemand pages.
            const isIGV = scope !== root || box.closest('.igv-axis-column, .igv-track-div, .igv-track') ||
              root.querySelector('.igv-column-container, .igv-track-label');
            if (!isIGV) continue;
            if (!inventory.has(scope)) inventory.set(scope, []);
            inventory.get(scope).push(box);
          }
        }
        for (const g of groups.values()) g.seen = false;
        for (const [scope, boxes] of inventory) {
          let g = groups.get(scope);
          if (!g) { g = newGroup(scope); groups.set(scope, g); }
          g.seen = true;
          const old = g.records;
          g.records = boxes.map((box, i) => { boxGroups.set(box, g); return descriptor(box, i, objects); });
          const currentBoxes = new Set(boxes);
          const topologyChanged = old.length !== boxes.length || old.some(r => !currentBoxes.has(r.box));
          if (topologyChanged) { g.undo = []; g.redo = []; if (!boxes.includes(g.anchor)) g.anchor = null; }
          const wasOn = g.enabled;
          g.enabled = g.records.some(r => r.modeOn && r.enabled);
          if (wasOn && !g.enabled) { g.undo = []; g.redo = []; g.anchor = null; }
          const rootHost = scope.getRootNode?.().host;
          const hint = safeText(rootHost?.id) || safeText(scope.id);
          g.label = `IGV ${g.id}${hint ? ' · ' + hint.slice(0, 35) : ''}`;
        }
        for (const [scope, g] of groups) if (!g.seen) groups.delete(scope);
        const live = Array.from(groups.values()).filter(g => g.enabled);
        if (!active?.seen || !active.enabled) { active = live[0] || null; if (ui && active) loadFilter(); }
        if (!active) { if (host) host.hidden = true; return; }
        ensureUI();
        host.hidden = false;
        updateUI(live);
      } catch (error) { console.warn('[IGV Track Helper] refresh:', error); }
      finally { scanning = false; }
    }
    function snapshot(g) { return new Map(g.records.filter(r => r.enabled).map(r => [r.box, r.box.checked])); }
    function equals(a, b) { return a.size === b.size && Array.from(a).every(([box, state]) => b.get(box) === state); }
    function remember(g, before, after, label) {
      if (equals(before, after)) return;
      g.undo.push({ before, after, label });
      if (g.undo.length > MAX_HISTORY) g.undo.shift();
      g.redo = [];
    }
    function applyState(g, states) {
      const valid = new Set(g.records.filter(r => r.enabled).map(r => r.box));
      suppress = true;
      try {
        for (const [box, value] of states) {
          if (valid.has(box) && box.isConnected && !box.disabled && box.checked !== value) box.click();
        }
      } finally { suppress = false; }
    }
    function batch(label, resolver, g = active) {
      if (!g?.enabled) return;
      const before = snapshot(g);
      const states = new Map(g.records.filter(r => r.enabled).map(r => [r.box, !!resolver(r)]));
      applyState(g, states);
      remember(g, before, snapshot(g), label);
      g.anchor = null;
      say(`${label}: ${g.records.filter(r => r.box.checked).length}/${g.records.length} selected.`);
      refresh();
    }
    function history(direction) {
      if (!active) return;
      const g = active, from = g[direction];
      const entry = from.at(-1);
      if (!entry) return;
      try {
        if (entry.kind === 'order') {
          const expected = direction === 'undo' ? entry.afterOrder : entry.beforeOrder;
          if (!sameOrder(entry.browser.trackViews, expected.views)) {
            g.undo = []; g.redo = [];
            say('Track order changed outside the helper. Order history was cleared.');
            refresh(); return;
          }
          restoreOrder(entry.browser, direction === 'undo' ? entry.beforeOrder : entry.afterOrder);
        } else applyState(g, direction === 'undo' ? entry.before : entry.after);
        from.pop(); g[direction === 'undo' ? 'redo' : 'undo'].push(entry);
        g.anchor = null;
        say(`${direction === 'undo' ? 'Undid' : 'Redid'}: ${entry.label}.`);
      } catch (error) {
        say(`Could not ${direction}: ${error.message}`);
      }
      refresh();
    }
    function eventBox(event, labels = false) {
      const path = event.composedPath?.() || [event.target];
      for (const el of path) {
        if (el?.matches?.(BOX)) return el;
        if (labels && el?.tagName === 'LABEL') {
          const control = el.control || el.querySelector(BOX);
          if (control?.matches?.(BOX)) return control;
        }
      }
      return null;
    }
    function onPointerDown(e) {
      const box = eventBox(e, true);
      if (box) {
        lastPointer = { box, shift: e.shiftKey, time: Date.now() };
        // Prevent browser text-range selection from swallowing a Shift-click
        // on a custom checkbox label. No unrelated page gestures are changed.
        if (e.shiftKey && !eventBox(e) && boxGroups.get(box)?.enabled) e.preventDefault();
      }
    }
    function onClick(e) {
      if (suppress) return;
      const box = eventBox(e);
      if (!box) {
        const control = eventBox(e, true);
        if (control && e.shiftKey && boxGroups.get(control)?.enabled && !control.disabled) {
          e.preventDefault(); // avoid a second native label activation
          lastPointer = { box: control, shift: true, time: Date.now() };
          control.click();
        }
        return;
      }
      let g = boxGroups.get(box);
      if (!g) { refresh(true); g = boxGroups.get(box); }
      if (!g?.enabled || box.disabled) return;
      if (active !== g) { active = g; if (ui) loadFilter(); }
      const anchor = g.anchor;
      const shifted = e.shiftKey || (lastPointer?.box === box && lastPointer.shift && Date.now() - lastPointer.time < 1500);
      lastPointer = null;
      // Native checkbox pre-activation toggles checked before click listeners.
      const before = snapshot(g);
      before.set(box, !box.checked);
      const done = () => {
        if (disposed || !box.isConnected || !g.enabled) return;
        if (shifted && anchor && anchor !== box) {
          const eligible = g.records.filter(r => r.enabled);
          const a = eligible.findIndex(r => r.box === anchor), b = eligible.findIndex(r => r.box === box);
          if (a >= 0 && b >= 0) {
            const states = new Map(eligible.slice(Math.min(a, b), Math.max(a, b) + 1).map(r => [r.box, box.checked]));
            applyState(g, states);
          }
        }
        g.anchor = box;
        remember(g, before, snapshot(g), shifted ? 'Shift range' : 'Track click');
        refresh();
      };
      // Use a task, not a microtask: let native activation and IGV's change
      // listener finish before reading the final state or starting a batch.
      win.setTimeout(done, 0);
    }

    // Group reordering is intentionally a model-level operation. IGV renders
    // tracks in parallel columns; moving only drag-handle DOM nodes corrupts
    // alignment and is never used here. Native single-track dragging remains
    // untouched unless the handle belongs to a multi-track selection.
    function sameOrder(a, b) {
      return Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i]);
    }
    function sameMembers(a, b) {
      return Array.isArray(a) && a.length === b.length && new Set(a).size === a.length &&
        b.every(v => a.includes(v));
    }
    function pinned(tv) { return ['ideogram', 'ruler'].includes(tv.track?.id) || ['ideogram', 'ruler'].includes(tv.track?.type); }
    function groupAdapter(g, selected) {
      const b = selected[0]?.trackView?.browser;
      if (!b || !knownBrowsers.has(b) || !b.columnContainer?.isConnected ||
          !Array.isArray(b.trackViews) || typeof b.reorderTracks !== 'function') return null;
      if (!selected.every(r => r.trackView?.browser === b && b.trackViews.includes(r.trackView) &&
          r.trackView.dragHandle === r.dragHandle && r.dragHandle?.matches('.igv-track-drag-handle') &&
          !pinned(r.trackView))) return null;
      if (!b.trackViews.every(tv => tv.track && tv.axis?.isConnected && tv.dragHandle?.isConnected &&
          Array.isArray(tv.viewports) && tv.viewports.length && tv.viewports.every(vp => vp.viewportElement?.isConnected))) return null;
      return b;
    }
    function captureOrder(b) {
      return { views: b.trackViews.slice(), values: b.trackViews.map(tv => ({
        tv, ownOrder: Object.hasOwn(tv.track, 'order'), order: tv.track.order,
        ownConfigOrder: !!tv.track.config && Object.hasOwn(tv.track.config, 'order'), configOrder: tv.track.config?.order
      })) };
    }
    function assignOrderSnapshot(b, state) {
      b.trackViews.splice(0, b.trackViews.length, ...state.views);
      for (const v of state.values) {
        if (v.ownOrder) v.tv.track.order = v.order; else delete v.tv.track.order;
        if (v.tv.track.config) {
          if (v.ownConfigOrder) v.tv.track.config.order = v.configOrder;
          else delete v.tv.track.config.order;
        }
      }
      b.reorderTracks();
      if (!sameOrder(b.trackViews, state.views)) throw new Error('IGV returned a different order');
    }
    function notifyOrder(b) {
      // IGV's own endTrackDrag emits this event after completing a move.
      try {
        const names = typeof b.getTrackOrder === 'function' ? b.getTrackOrder() :
          b.trackViews.filter(tv => tv.track?.name).map(tv => tv.track.name);
        b.fireEvent?.('trackorderchanged', [names]);
      } catch (error) { console.warn('[IGV Track Helper] order-change listener:', error); }
    }
    function restoreOrder(b, state) {
      if (!sameMembers(b.trackViews, state.views)) throw new Error('The track list changed; reload or remove operations cannot be undone here');
      const previous = captureOrder(b);
      committingOrder = true;
      try {
        assignOrderSnapshot(b, state);
      } catch (error) {
        try { assignOrderSnapshot(b, previous); }
        catch (rollbackError) { console.error('[IGV Track Helper] rollback failed:', rollbackError); }
        throw error;
      } finally { committingOrder = false; }
      notifyOrder(b);
    }
    function commitOrder(b, ordered) {
      const before = captureOrder(b);
      const next = { views: ordered, values: ordered.map((tv, i) => {
        const old = before.values.find(v => v.tv === tv);
        // Keep the special header order; retain a bottom sentinel on an
        // untouched bottom track, so later tracks can still load above it.
        const keep = pinned(tv) || (tv === before.views.at(-1) && tv === ordered.at(-1) &&
          typeof old.order === 'number' && old.order >= Number.MAX_SAFE_INTEGER);
        return { tv, ownOrder: keep ? old.ownOrder : true, order: keep ? old.order : i + 1,
          ownConfigOrder: keep ? old.ownConfigOrder : !!tv.track.config,
          configOrder: keep ? old.configOrder : i + 1 };
      }) };
      restoreOrder(b, next);
      return { before, after: captureOrder(b) };
    }
    function handleInEvent(e) {
      return (e.composedPath?.() || [e.target]).find(n => n?.matches?.('.igv-track-drag-handle'));
    }
    function dragClip(column) {
      const r = column.getBoundingClientRect();
      let left = Math.max(0, r.left), right = Math.min(win.innerWidth, r.right);
      let top = Math.max(0, r.top), bottom = Math.min(win.innerHeight, r.bottom);
      for (let n = parent(column); n?.nodeType === 1; n = parent(n)) {
        const css = win.getComputedStyle(n), rect = n.getBoundingClientRect();
        if (/(auto|scroll|hidden|clip)/.test(css.overflowX)) { left = Math.max(left, rect.left); right = Math.min(right, rect.right); }
        if (/(auto|scroll|hidden|clip)/.test(css.overflowY)) { top = Math.max(top, rect.top); bottom = Math.min(bottom, rect.bottom); }
      }
      return { left, right, top, bottom };
    }
    function beginGroupDrag(e) {
      if (disposed || e.button !== 0 || trackDrag) return;
      const handle = handleInEvent(e);
      if (!handle) return;
      refresh(true);
      let g, dragged;
      for (const candidate of groups.values()) {
        const r = candidate.records.find(item => item.dragHandle === handle);
        if (r) { g = candidate; dragged = r; break; }
      }
      if (!g?.enabled || !dragged?.box.checked) return;
      const selected = g.records.filter(r => r.enabled && r.box.checked);
      if (selected.length < 2) return; // leave IGV's normal single drag alone
      // Do not silently fall back to moving only one track when the user
      // intended to move a group.
      e.preventDefault(); e.stopImmediatePropagation();
      const b = groupAdapter(g, selected);
      if (!b) { say('Group drag unavailable in this IGV build. No tracks were moved. Clear the selection to use individual dragging.'); return; }
      if (active !== g) { active = g; if (ui) loadFilter(); }
      const original = b.trackViews.slice();
      const selectedViews = new Set(selected.map(r => r.trackView));
      const moving = original.filter(tv => selectedViews.has(tv));
      const remaining = original.filter(tv => !selectedViews.has(tv));
      const d = { g, browser: b, column: b.columnContainer, original, moving, remaining,
        startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY,
        started: false, valid: false, ordered: null, ghost: null, line: null,
        styles: [], raf: 0, listeners: [], scrollParents: [], lastFrame: 0 };
      trackDrag = d;
      for (let n = d.column; n?.nodeType === 1; n = parent(n)) {
        if (n !== doc.documentElement && n !== doc.body && /(auto|scroll)/.test(win.getComputedStyle(n).overflowY)) d.scrollParents.push(n);
      }
      const scroller = doc.scrollingElement;
      if (scroller && !d.scrollParents.includes(scroller)) d.scrollParents.push(scroller);
      const bind = (target, type, fn) => {
        target.addEventListener(type, fn, true);
        d.listeners.push(() => target.removeEventListener(type, fn, true));
      };
      bind(doc, 'mousemove', moveGroupDrag);
      bind(doc, 'mouseup', finishGroupDrag);
      bind(win, 'blur', cancelGroupDrag);
      bind(doc, 'visibilitychange', () => { if (doc.hidden) cancelGroupDrag(); });
      bind(doc, 'dragstart', ev => { if (trackDrag) { ev.preventDefault(); ev.stopImmediatePropagation(); } });
    }
    function createDragFeedback(d) {
      d.ghost = element('div', { 'data-igv-group-drag': 'badge', role: 'status' });
      d.ghost.style.cssText = 'all:initial;position:fixed;pointer-events:none;z-index:2147483647;padding:7px 11px;border-radius:7px;background:#125d75;color:#fff;font:600 12px system-ui;box-shadow:0 2px 9px #0003;white-space:nowrap;';
      d.line = element('div', { 'data-igv-group-drag': 'line' });
      d.line.style.cssText = 'all:initial;position:fixed;pointer-events:none;z-index:2147483646;height:3px;background:#168aa6;box-shadow:0 0 0 1px #fff;';
      doc.body.append(d.ghost, d.line);
      for (const tv of d.moving) {
        const el = tv.dragHandle;
        d.styles.push({ el, value: el.style.getPropertyValue('box-shadow'), priority: el.style.getPropertyPriority('box-shadow') });
        el.style.setProperty('box-shadow', 'inset 0 0 0 2px #168aa6');
      }
    }
    function moveGroupDrag(e) {
      const d = trackDrag;
      if (!d) return;
      if (!(e.buttons & 1)) { cancelGroupDrag(); return; }
      e.preventDefault(); e.stopImmediatePropagation();
      d.x = e.clientX; d.y = e.clientY;
      if (!d.started && Math.hypot(d.x - d.startX, d.y - d.startY) >= 5) {
        d.started = true; createDragFeedback(d);
        d.raf = win.requestAnimationFrame(scrollGroupDrag);
      }
      if (d.started) previewGroupDrop(d);
    }
    function previewGroupDrop(d) {
      if (!d.column.isConnected || !sameOrder(d.browser.trackViews, d.original)) { cancelGroupDrag(); return; }
      const clip = dragClip(d.column);
      const overHelper = doc.elementFromPoint(d.x, d.y) === host;
      d.valid = !overHelper && clip.right > clip.left && clip.bottom > clip.top &&
        d.x >= clip.left - 8 && d.x <= clip.right + 8 && d.y >= clip.top && d.y <= clip.bottom;
      if (d.valid) {
        const eligible = d.remaining.filter(tv => !pinned(tv));
        let following = null;
        for (const tv of eligible) {
          const rect = tv.dragHandle.getBoundingClientRect();
          if (d.y < (rect.top + rect.bottom) / 2) { following = tv; break; }
        }
        // The ruler/ideogram are always above the tracks, never a drop target.
        const index = following ? d.remaining.indexOf(following) : d.remaining.length;
        d.ordered = [...d.remaining.slice(0, index), ...d.moving, ...d.remaining.slice(index)];
        let lineY;
        if (following) lineY = following.dragHandle.getBoundingClientRect().top;
        else if (d.remaining.length) lineY = d.remaining.at(-1).dragHandle.getBoundingClientRect().bottom;
        else lineY = d.column.getBoundingClientRect().top;
        lineY = Math.max(clip.top, Math.min(clip.bottom - 3, lineY));
        d.line.style.display = 'block'; d.line.style.left = clip.left + 'px';
        d.line.style.top = lineY + 'px'; d.line.style.width = Math.max(0, clip.right - clip.left) + 'px';
        d.ghost.textContent = `Move ${d.moving.length} tracks · release to drop`;
      } else {
        d.ordered = null; d.line.style.display = 'none';
        d.ghost.textContent = 'Release outside this IGV to cancel';
      }
      d.ghost.style.left = Math.max(8, Math.min(d.x + 14, win.innerWidth - d.ghost.offsetWidth - 8)) + 'px';
      d.ghost.style.top = Math.max(8, Math.min(d.y + 16, win.innerHeight - d.ghost.offsetHeight - 8)) + 'px';
    }
    function scrollGroupDrag(time) {
      const d = trackDrag;
      if (!d?.started) return;
      const elapsed = Math.min(32, d.lastFrame ? time - d.lastFrame : 16);
      d.lastFrame = time;
      const clip = dragClip(d.column), edge = Math.min(38, (clip.bottom - clip.top) / 3);
      if (d.x >= clip.left - 8 && d.x <= clip.right + 8 && d.y >= clip.top - 2 && d.y <= clip.bottom + 2) {
        let speed = 0;
        if (d.y < clip.top + edge) speed = -Math.min(1, (clip.top + edge - d.y) / edge);
        else if (d.y > clip.bottom - edge) speed = Math.min(1, (d.y - (clip.bottom - edge)) / edge);
        if (speed) {
          for (const node of d.scrollParents) {
            if (node.scrollHeight <= node.clientHeight + 1) continue;
            const before = node.scrollTop;
            node.scrollTop += speed * elapsed * 0.65;
            if (node.scrollTop !== before) { previewGroupDrop(d); break; }
          }
        }
      }
      if (trackDrag === d) d.raf = win.requestAnimationFrame(scrollGroupDrag);
    }
    function cleanDrag(d) {
      win.cancelAnimationFrame(d.raf);
      for (const off of d.listeners) off();
      d.ghost?.remove(); d.line?.remove();
      for (const { el, value, priority } of d.styles) {
        if (value) el.style.setProperty('box-shadow', value, priority);
        else el.style.removeProperty('box-shadow');
      }
    }
    function cancelGroupDrag() {
      const d = trackDrag;
      if (!d) return;
      trackDrag = null; cleanDrag(d);
      if (d.started) say('Move cancelled; track order unchanged.');
      schedule();
    }
    function finishGroupDrag(e) {
      const d = trackDrag;
      if (!d || e.button !== 0) return;
      e.preventDefault(); e.stopImmediatePropagation();
      d.x = e.clientX; d.y = e.clientY;
      if (d.started) previewGroupDrop(d);
      if (trackDrag !== d) return;
      trackDrag = null; cleanDrag(d);
      if (!d.started) { refresh(); return; }
      if (!d.valid || !d.ordered) { say('Move cancelled; track order unchanged.'); refresh(); return; }
      if (!sameOrder(d.browser.trackViews, d.original)) { say('Track order changed during dragging; move cancelled.'); refresh(); return; }
      if (sameOrder(d.original, d.ordered)) { say('Selected tracks are already at this position.'); refresh(); return; }
      try {
        const state = commitOrder(d.browser, d.ordered);
        d.g.undo.push({ kind: 'order', browser: d.browser, beforeOrder: state.before, afterOrder: state.after,
          label: `Move ${d.moving.length} tracks` });
        if (d.g.undo.length > MAX_HISTORY) d.g.undo.shift();
        d.g.redo = []; d.g.anchor = null;
        say(`Moved ${d.moving.length} tracks together. Their relative order was preserved. Undo restores the previous order.`);
      } catch (error) {
        console.warn('[IGV Track Helper] group move:', error);
        say(`Could not complete the group move: ${error.message}`);
      }
      refresh();
    }

    function element(tag, props = {}, text) {
      const el = doc.createElement(tag);
      for (const [k, v] of Object.entries(props)) {
        if (k === 'class') el.className = v;
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k in el) el[k] = v;
        else el.setAttribute(k, v);
      }
      if (text !== undefined) el.textContent = text;
      return el;
    }
    function button(id, label, fn, title) {
      const b = element('button', { type: 'button', id, title: title || label }, label);
      b.addEventListener('click', fn);
      return b;
    }
    function select(id, options) {
      const s = element('select', { id });
      for (const [value, text] of options) s.append(element('option', { value }, text));
      return s;
    }
    function field(label, input) {
      const l = element('label', { class: 'field' });
      l.append(element('span', {}, label), input); return l;
    }
    function check(id, text) {
      const l = element('label', { class: 'check' });
      l.append(element('input', { type: 'checkbox', id }), doc.createTextNode(text)); return l;
    }
    function details(id, title, open = false) {
      const d = element('details', { id, open }); d.append(element('summary', {}, title)); return d;
    }
    function say(text) { message = text; if (ui) ui.getElementById('message').textContent = text; }
    function by(id) { return ui.getElementById(id); }
    function ensureUI() {
      if (host?.isConnected) return;
      if (!doc.body) return;
      host = element('div', { id: HOST_ID });
      host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;display:block;';
      ui = host.attachShadow({ mode: 'open' });
      const style = element('style', {}, `
        :host([hidden]){display:none!important}
        :host{color-scheme:light;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#172a3b;font-size:12px;line-height:1.4}
        *{box-sizing:border-box} [hidden]{display:none!important}
        #panel{font:12px/1.4 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#172a3b;color-scheme:light;width:352px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);overflow:auto;border:1px solid #ccd8df;border-radius:12px;background:#fff;box-shadow:0 5px 24px #142c4429}
        #panel.collapsed{width:auto;min-width:236px} header{position:sticky;top:0;z-index:1;display:flex;align-items:center;gap:7px;padding:10px 11px;background:#eff5f8;cursor:grab;user-select:none;touch-action:none;border-bottom:1px solid #dde6ec}
        header strong{font-size:13px;flex:1;white-space:nowrap} .grip{color:#68808e;font-size:15px} #body{padding:10px 11px} .row{display:flex;gap:6px;align-items:center;margin-bottom:7px} .row>*{min-width:0} .row>select{flex:1;width:auto}.row>button{flex-shrink:0} .grow{flex:1}
        button,input,select,textarea{font:inherit;color:inherit} button{border:1px solid #cdd9e1;border-radius:6px;background:#f8fafc;padding:6px 9px;cursor:pointer;white-space:nowrap} button:hover:not(:disabled){background:#e8f1f6;border-color:#91a9b8} button:disabled{opacity:.42;cursor:default} button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:2px solid #167aa0;outline-offset:2px}
        .primary{background:#11667f;color:white;border-color:#11667f}.primary:hover:not(:disabled){background:#0c5369} #count{font-weight:650;background:#fff;color:#145b73;border-color:#c3d8e1;padding:3px 7px} #collapse{border:0;background:transparent;padding:1px 6px;font-size:18px}
        .main button{flex:1} input[type=text],select,textarea{width:100%;border:1px solid #c9d6df;background:#fff;border-radius:5px;padding:6px 7px} textarea{resize:vertical;min-height:80px}.field{display:block;flex:1;margin-bottom:7px}.field>span{display:block;margin-bottom:3px;font-size:11px;color:#516b7b}.check{display:flex;gap:4px;align-items:center;white-space:nowrap}.check input{margin:0}
        details{border-top:1px solid #e3ebf0;margin-top:8px;padding-top:7px} summary{cursor:pointer;font-weight:600;padding:2px 0 7px} .hint{font-size:11px;color:#5b7181;margin:2px 0 7px}.error{color:#b03535} #match-count{font-weight:600} #metadata-note{margin-top:4px} #message{font-size:11px;color:#476372;margin-top:8px;overflow-wrap:anywhere} footer{display:flex;justify-content:space-between;align-items:center;color:#8495a0;margin-top:6px;font-size:10px} .link{border:0;background:none;padding:1px 0;color:#476b80;font-size:10px}
        #selected-list{max-height:190px;overflow:auto;margin:0;padding:0;list-style:none} #selected-list li{padding:5px 0;border-bottom:1px solid #edf2f5;overflow-wrap:anywhere;display:flex;gap:7px;align-items:flex-start} #selected-list .name{flex:1} .tag{font-size:10px;color:#5a7485;background:#eff4f7;padding:1px 5px;border-radius:4px;white-space:nowrap} #view-row{margin-bottom:8px} .small{font-size:11px} .selected-top{justify-content:space-between}
      `);
      const panel = element('section', { id: 'panel', 'aria-label': 'IGV Track Helper' });
      const header = element('header', { title: 'Drag to move the toolbar' });
      header.append(element('span', { class: 'grip', 'aria-hidden': 'true' }, '⠿'), element('strong', {}, 'IGV Tracks'),
        button('count', '0/0', () => { if (settings.collapsed) toggleCollapsed(); by('selected').open = !by('selected').open; updateSelected(); }, 'Show selected track names'),
        button('collapse', '−', toggleCollapsed, 'Collapse toolbar'));
      panel.append(header);
      const body = element('div', { id: 'body' });
      const viewRow = element('div', { id: 'view-row' });
      const views = select('viewer', []);
      views.setAttribute('aria-label', 'Active IGV viewer');
      views.addEventListener('change', () => { active = Array.from(groups.values()).find(g => g.id === views.value); loadFilter(); refresh(); });
      viewRow.append(views); body.append(viewRow);
      const main = element('div', { class: 'row main' });
      main.append(button('all', 'Select All', () => batch('Select All', () => true)),
        button('invert', 'Invert', () => batch('Invert', r => !r.box.checked)),
        button('clear', 'Clear All', () => batch('Clear All', () => false), 'Deselect tracks; does not remove or delete them'));
      body.append(main);
      const utility = element('div', { class: 'row' });
      utility.append(button('undo', 'Undo', () => history('undo')), button('redo', 'Redo', () => history('redo')),
        button('copy', 'Copy Names', copyNames, 'Copy selected track names in display order'));
      body.append(utility);
      body.append(element('p', { id: 'drag-hint', class: 'hint' }, 'Select tracks, then drag any selected track handle to move them together.'));

      const filter = details('filters', 'Filter & select');
      const include = element('input', { id: 'include', type: 'text', placeholder: 'e.g. K562', maxLength: 256 });
      const exclude = element('input', { id: 'exclude', type: 'text', placeholder: 'e.g. input|control', maxLength: 256 });
      filter.append(field('Include name', include), field('Exclude name', exclude));
      const flags = element('div', { class: 'row small' });
      flags.append(check('regex', 'Regex'), check('matchCase', 'Match case'));
      filter.append(flags);
      const types = select('type', [
        ['', 'All track types'], ['group:quantitative', 'Quantitative'], ['group:annotation', 'Annotation'],
        ['group:alignment', 'Alignment'], ['group:variant', 'Variant'], ['group:interaction', 'Interaction'],
        ['format:bigwig', 'BigWig'], ['format:bigbed', 'BigBed'], ['format:bed', 'BED'],
        ['format:bam', 'BAM'], ['format:cram', 'CRAM'], ['format:vcf', 'VCF'],
        ['format:bedgraph', 'bedGraph'], ['format:gtf', 'GTF'], ['format:gff3', 'GFF3'], ['unknown', 'Unknown file format']
      ]);
      filter.append(field('Track type', types));
      const matches = element('div', { id: 'match-count', class: 'hint', 'aria-live': 'polite' }); filter.append(matches);
      const action = select('action', [['replace', 'Replace selection'], ['add', 'Add to selection'], ['remove', 'Remove from selection']]);
      action.setAttribute('aria-label', 'Filter action');
      const applyRow = element('div', { class: 'row' });
      const apply = button('apply', 'Apply Filter', applyFilter); apply.classList.add('primary');
      applyRow.append(action, apply); filter.append(applyRow);
      const resetRow = element('div', { class: 'row' });
      resetRow.append(button('reset-filter', 'Reset Filter', () => { active.filter = newGroup(null).filter; loadFilter(); refresh(); }, 'Reset filter controls without changing selection'));
      filter.append(resetRow, element('p', { id: 'metadata-note', class: 'hint' }));
      body.append(filter);

      const selected = details('selected', 'Selected tracks');
      selected.addEventListener('toggle', updateSelected);
      selected.append(element('ul', { id: 'selected-list' }), element('p', { id: 'selected-note', class: 'hint' }));
      const copyFallback = element('textarea', { id: 'copy-fallback', readOnly: true, hidden: true, 'aria-label': 'Selected names to copy manually' });
      selected.append(copyFallback); body.append(selected);
      body.append(element('div', { id: 'message', role: 'status', 'aria-live': 'polite' }, message));
      const footer = element('footer');
      footer.append(button('reset-position', 'Reset position', () => { settings.top = 8; settings.right = 8; place(); write('settings', settings); }), element('span', {}, `v${VERSION} · No keyboard shortcuts`));
      footer.firstChild.classList.add('link'); body.append(footer);
      panel.append(body); ui.append(style, panel); doc.body.append(host);
      for (const id of ['include', 'exclude', 'regex', 'matchCase', 'type', 'action']) {
        by(id).addEventListener('input', () => { saveFilter(); updateFilter(); });
      }
      // Events are contained in the helper's own Shadow DOM. No key event
      // handlers are installed: normal browser/IGV shortcuts remain untouched.
      header.addEventListener('pointerdown', startDrag);
      const resizeObserver = new win.ResizeObserver(() => place());
      resizeObserver.observe(panel); cleanups.push(() => resizeObserver.disconnect());
      loadFilter(); syncCollapsed(); place();
    }
    function toggleCollapsed() {
      settings.collapsed = !settings.collapsed;
      write('settings', settings); syncCollapsed(); place();
    }
    function syncCollapsed() {
      if (!ui) return;
      by('body').hidden = settings.collapsed;
      by('panel').classList.toggle('collapsed', settings.collapsed);
      by('collapse').textContent = settings.collapsed ? '+' : '−';
      by('collapse').title = settings.collapsed ? 'Expand toolbar' : 'Collapse toolbar';
      by('collapse').setAttribute('aria-expanded', String(!settings.collapsed));
    }
    function place() {
      if (!host || host.hidden) return;
      const rect = host.getBoundingClientRect();
      settings.right = Math.max(8, Math.min(settings.right, Math.max(8, win.innerWidth - rect.width - 8)));
      settings.top = Math.max(8, Math.min(settings.top, Math.max(8, win.innerHeight - rect.height - 8)));
      host.style.top = settings.top + 'px'; host.style.right = settings.right + 'px';
    }
    function startDrag(e) {
      if (e.button !== 0 || e.target.closest('button')) return;
      e.preventDefault();
      const header = e.currentTarget, x = e.clientX, y = e.clientY;
      const before = { ...settings };
      header.setPointerCapture(e.pointerId);
      const move = ev => {
        settings.right = before.right - (ev.clientX - x);
        settings.top = before.top + (ev.clientY - y); place();
      };
      const stop = () => {
        header.removeEventListener('pointermove', move);
        header.removeEventListener('pointerup', stop);
        header.removeEventListener('pointercancel', stop);
        write('settings', settings);
      };
      header.addEventListener('pointermove', move); header.addEventListener('pointerup', stop);
      header.addEventListener('pointercancel', stop);
    }
    function saveFilter() {
      if (!active || !ui) return;
      for (const id of ['include', 'exclude', 'type', 'action']) active.filter[id] = by(id).value;
      for (const id of ['regex', 'matchCase']) active.filter[id] = by(id).checked;
    }
    function loadFilter() {
      if (!active || !ui) return;
      for (const id of ['include', 'exclude', 'type', 'action']) by(id).value = active.filter[id];
      for (const id of ['regex', 'matchCase']) by(id).checked = active.filter[id];
    }
    function makeMatcher(f) {
      // Regex is opt-in. Reject invalid syntax without changing selection.
      const pattern = text => {
        if (!text) return null;
        if (f.regex) return new RegExp(text, f.matchCase ? '' : 'i');
        const needle = f.matchCase ? text : text.toLowerCase();
        return { test: value => (f.matchCase ? value : value.toLowerCase()).includes(needle) };
      };
      const inc = pattern(f.include), exc = pattern(f.exclude);
      return r => {
        if (!r.enabled) return false;
        if ((inc || exc) && !r.nameKnown) return false;
        if (inc && !inc.test(r.name)) return false;
        if (exc && exc.test(r.name)) return false;
        if (f.type.startsWith('group:') && r.type !== f.type.slice(6)) return false;
        if (f.type.startsWith('format:') && r.format !== f.type.slice(7)) return false;
        if (f.type === 'unknown' && r.format) return false;
        return true;
      };
    }
    function updateFilter() {
      if (!ui || !active) return;
      try {
        const predicate = makeMatcher(active.filter);
        const n = active.records.filter(predicate).length;
        by('match-count').textContent = `${n} / ${active.records.length} tracks match`;
        by('match-count').classList.remove('error'); by('apply').disabled = false;
      } catch (e) {
        by('match-count').textContent = `Invalid regex: ${e.message}`;
        by('match-count').classList.add('error'); by('apply').disabled = true;
      }
      const unknown = active.records.filter(r => !r.format).length;
      const unnamed = active.records.filter(r => !r.nameKnown).length;
      by('metadata-note').textContent = [
        unknown ? `${unknown} exact file formats unknown; use broad types when needed.` : '',
        unnamed ? `${unnamed} names unavailable; excluded from name filters.` : ''
      ].filter(Boolean).join(' ');
    }
    function applyFilter() {
      refresh(); if (!active) return;
      saveFilter();
      try {
        const match = makeMatcher(active.filter);
        const mode = active.filter.action;
        batch('Apply Filter', r => mode === 'add' ? r.box.checked || match(r) :
          mode === 'remove' ? r.box.checked && !match(r) : match(r));
      } catch (e) { say(`Invalid regex; selection unchanged. ${e.message}`); }
    }
    function updateUI(live) {
      if (!ui || !active) return;
      const n = active.records.filter(r => r.box.checked).length;
      by('count').textContent = `${n}/${active.records.length}`;
      by('view-row').hidden = live.length <= 1;
      const currentViewIDs = Array.from(by('viewer').options).map(o => o.value).join(',');
      if (currentViewIDs !== live.map(g => g.id).join(',')) {
        by('viewer').replaceChildren(...live.map(g => element('option', { value: g.id }, g.label)));
      }
      by('viewer').value = active.id;
      by('undo').disabled = !active.undo.length; by('redo').disabled = !active.redo.length;
      by('undo').title = active.undo.length ? `Undo: ${active.undo.at(-1).label}` : 'Nothing to undo';
      by('redo').title = active.redo.length ? `Redo: ${active.redo.at(-1).label}` : 'Nothing to redo';
      by('copy').disabled = n === 0;
      const selected = active.records.filter(r => r.enabled && r.box.checked);
      const draggable = selected.length >= 2 && groupAdapter(active, selected);
      by('drag-hint').textContent = selected.length < 2 ?
        'Select two or more tracks, then drag any selected track handle to move them together.' :
        draggable ? `Drag any selected track handle to move these ${selected.length} tracks together.` :
        'Group drag unavailable: this viewer does not expose a compatible IGV sorting object. Selection tools still work.';
      updateFilter(); if (by('selected').open) updateSelected(); place();
    }
    function updateSelected() {
      if (!ui || !active || !by('selected').open) return;
      const selected = active.records.filter(r => r.box.checked);
      const signature = selected.map(r => `${r.name}\0${r.format}\0${r.type}`).join('\n');
      if (by('selected-list').dataset.signature !== signature) {
        by('selected-list').dataset.signature = signature;
        by('selected-list').replaceChildren(...selected.map(r => {
          const li = element('li'); li.append(element('span', { class: 'name' }, r.name),
            element('span', { class: 'tag', title: r.formatSource || 'Broad IGV type; exact format unavailable' }, r.format || r.type)); return li;
        }));
      }
      by('selected-note').textContent = selected.length ? `${selected.length} selected, in track order.` : 'No tracks selected.';
    }
    async function copyNames() {
      if (!active) return;
      const chosen = active.records.filter(r => r.box.checked);
      const names = chosen.filter(r => r.nameKnown).map(r => r.name);
      if (!names.length) { say('Track names are not available; nothing copied.'); return; }
      const text = names.join('\n');
      try {
        if (!win.navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
        await win.navigator.clipboard.writeText(text);
        say(`Copied ${names.length} names.${chosen.length !== names.length ? ' Unavailable names skipped.' : ''}`);
      } catch (_) {
        if (disposed) return;
        if (settings.collapsed) toggleCollapsed();
        by('selected').open = true; const area = by('copy-fallback');
        area.hidden = false; area.value = text; area.focus(); area.select();
        say('Clipboard access was blocked. Copy the highlighted text manually.');
      }
    }

    function dispose() {
      if (disposed) return;
      cancelGroupDrag();
      disposed = true;
      win.clearTimeout(timer); win.clearInterval(poll);
      for (const observer of roots.values()) observer.disconnect(); roots.clear();
      for (const fn of cleanups) { try { fn(); } catch (_) { /* detached frame */ } }
      for (const child of childDocs) { try { child[KEY]?.dispose(); } catch (_) { /* detached */ } }
      host?.remove(); groups.clear(); knownBrowsers.clear(); delete doc[KEY];
      ownControllers.delete(controller);
    }
    const controller = { version: VERSION, dispose };
    doc[KEY] = controller; ownControllers.add(controller);
    listen(doc, 'pointerdown', onPointerDown, true);
    listen(doc, 'click', onClick, true);
    listen(doc, 'mousedown', beginGroupDrag, true);
    listen(win, 'resize', () => { place(); schedule(); });
    listen(doc, 'scroll', schedule, { capture: true, passive: true });
    refresh(true);
    poll = win.setInterval(() => { if (!doc.hidden) refresh(); }, 1200);
  }
  start(document);
})();
