# MapGenie Userscripts

Small userscripts that improve everyday use of [MapGenie](https://mapgenie.io/).

These scripts are unofficial and are not affiliated with, endorsed by, or officially connected to MapGenie.

## Available scripts

| Script | Description | Install |
|---|---|:---:|
| [MapGenie — Hide Top Right Sidebar](./mapgenie-auto-hide-right-sidebar.user.js) | Automatically closes the right-hand sidebar when a MapGenie map loads. | [Install](./mapgenie-auto-hide-right-sidebar.user.js) |
| [MapGenie — Icon Size Slider](./mapgenie-icon-size-slider.user.js) | Adds a slider and numeric input for adjusting the size of map icons. | [Install](./mapgenie-icon-size-slider.user.js) |

## Installation

1. Install a userscript manager:
   - [Tampermonkey](https://www.tampermonkey.net/) — Chrome, Firefox, Safari, Edge and Opera
   - [Violentmonkey](https://violentmonkey.github.io/) — Chrome, Firefox and Edge
   - [Greasemonkey](https://www.greasespot.net/) — Firefox

2. Open one of the scripts above and select **Raw**, or use its **Install** link.

3. Your userscript manager should prompt you to install it.

Scripts installed from Greasy Fork will normally update automatically through your userscript manager.

## MapGenie — Hide Top Right Sidebar

Automatically closes the right-hand sidebar when you open a MapGenie map.

The script waits briefly for the map interface to load, then closes the sidebar if it is open. It does not repeatedly toggle the sidebar, so you can still open it manually whenever you need it.

### What it does

- Runs on MapGenie map pages.
- Closes the right sidebar shortly after the page loads.
- Uses MapGenie’s own sidebar close control.
- Stops after the sidebar has been closed, or after a short timeout if it does not appear.

### What it does not do

- It does not change map data or game progress.
- It does not collect or send personal information.
- It does not prevent you from reopening the sidebar.

## MapGenie — Icon Size Slider

Adds an **Icon Size** control to MapGenie so you can make map icons larger or smaller.

This is useful if icons are difficult to see on a busy map, or if you prefer a cleaner view with smaller icons. Your chosen size is saved locally and remembered separately for each MapGenie game.

### Features

- Adds an **ICON SIZE** slider to the MapGenie interface.
- Adjusts icon size dynamically while you use the map.
- Includes a numeric field for entering a precise value.
- Saves your preference in your browser’s local storage.
- Keeps a separate saved size for each MapGenie game.
- Double-click the **ICON SIZE** label to reset the size to `1.00`.
- Uses colours and typography from the current MapGenie interface where possible.

### How it works

The script scales supported map icon layers rather than replacing their original sizes. This means it applies your chosen value as a multiplier to the size MapGenie already uses for each icon layer.

### Notes

- Settings are stored locally in your browser and are not synced between devices or browsers.
- The slider affects supported map icon layers; it may not affect every visual element on the page.
- If MapGenie changes its map interface or layer structure, the script may need an update.

## Troubleshooting

If a script does not appear to work:

1. Confirm that your userscript manager is enabled for `mapgenie.io`.
2. Refresh the MapGenie page after installing or updating a script.
3. Check that no other extension or userscript is interfering with the page.
4. Open your browser console and look for errors from the script.
5. If the problem continues, [open an issue](https://github.com/Reacien/Userscripts/issues).

When reporting a problem, include:

- The script name and version
- Your browser and userscript manager
- The MapGenie game or map you were using
- What you expected and what actually happened
- Any relevant console errors or screenshots

## Source and support

- **Repository:** [Reacien/Userscripts](https://github.com/Reacien/Userscripts)
- **Report an issue:** [Open a GitHub issue](https://github.com/Reacien/Userscripts/issues)
- **Suggest a feature:** [Open a GitHub issue](https://github.com/Reacien/Userscripts/issues)

## License

All scripts in this repository are provided as-is under the [GNU GPLv3](https://www.gnu.org/licenses/gpl-3.0.html) unless otherwise specified.
