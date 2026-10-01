# IGV-Web Track Helper

I often use **IGV-Web with dozens of tracks**, but selecting and organizing many tracks one by one is quite inconvenient. In particular, IGV-Web does not provide an easy way to select all tracks.

So I built this small userscript together with Codex to make track management easier.

## KU Leuven Open OnDemand

The script works with IGV-Web running through **KU Leuven Open OnDemand**, including sessions running on different compute nodes.

## Installation

1. Install **Tampermonkey** in your browser.
2. Drag `igv-track-helper.user.js` into Tampermonkey and install it.
3. Open IGV-Web as usual.

## Usage

Click **Select Tracks** in IGV-Web and the helper window will appear automatically.

It supports:

- **Select All / Invert / Clear All**
- **Shift-click** to select a continuous range of tracks
- Select individual, non-contiguous tracks
- Filter/select tracks by **track-name keywords**
- Select tracks by track type
- **Undo / Redo**
- Copy selected track names
- Select multiple tracks and **drag them together** to a new position while preserving their order

That's it — no changes to IGV-Web itself are required.
