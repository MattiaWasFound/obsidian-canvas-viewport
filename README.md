# Canvas Viewport for Obsidian

This plugin allows you to save and restore viewport positions in Obsidian Canvas.

![Preview Gif](preview.gif)

## Features
- Save current viewport position (zoom level and pan position)
- Automatically restore viewport position when opening a canvas
- Works with multiple canvases open at once — each canvas restores its own viewport
- (Optionally) Save different Canvas viewports for different devices
- Syncs with Obsidian Sync (stores data in the canvas file)

Compatible with the latest Obsidian (tested against 1.13.x; requires 1.5.7+).

## Usage
1. Open a canvas
2. Position the viewport as desired
3. Use the command "Save current viewport position"
4. The viewport will be restored next time you open the canvas

## Commands
- `Save current viewport`: Saves the current zoom level and pan position
- `Delete saved viewport`: Removes the saved viewport
- `Restore saved viewport` : Restore the saved viewport

## Tips
For Big Canvases I find it useful to have the Restore Saved Viewport command saved to a hotkey so I can always go back to a certain viewport.

## Roadmap
Ability to save multiple Viewports per file.