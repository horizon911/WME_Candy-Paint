# WME Candy Paint

A userscript designed to provide additional geometry and polygon editing tools for the Waze Map Editor (WME). 

Building upon the concepts of traditional image editing software, WME Candy Paint aims to assist map editors in creating, modifying, and managing complex Area Places (Venues) using basic shapes and Boolean operations.

## Key Features

* **Shape Tools:** Draw basic geometry including rectangles, ellipses, freehand lassos, and standard polygons.
* **Boolean Operations:** Combine shapes using standard operators (Union/Add, Difference/Subtract, Intersect, and XOR) to create complex footprints.
* **Draft & Master Workflows:** Shapes are first drawn as interactive "Drafts" allowing for rotation, scaling, and movement before being committed to a staging layer.
* **WME Integration:** "Ingest" existing WME Area Places to modify them, and "Apply" your finished geometry directly back to the map as a new or updated Place.
* **Measurement & Math:** Includes a basic geodesic measuring tool and a live tracker to monitor area and perimeter calculations during drafting.

## Basic Workflow

1. **Select a Tool:** Choose a shape tool (Rectangle, Ellipse, Polygon) from the floating palette.
2. **Draw a Draft:** Click and drag on the map. Adjust the draft using the control points.
3. **Choose an Operation:** Select how this shape should interact with your existing staging layer (e.g., Replace, Add, or Subtract).
4. **Commit:** Press `Enter` (or use the green checkmark) to merge the draft into your staging layer.
5. **Apply:** Once your geometry is complete, click **Apply** to inject the shape into WME as a Landmark/Venue.

## Installation

1. Ensure you have a userscript manager installed in your browser (such as [Tampermonkey](https://www.tampermonkey.net/)).
2. Install the script via GreasyFork or by adding the `.user.js` file directly to your extension.
3. Refresh the Waze Map Editor. The Candy Paint floating palette will appear on the right side of your screen.

*Note: This script relies on the [WME SDK Plus](https://github.com/WazeSpace/wme-sdk-plus) and the `polygon-clipping` library to function.*

## Disclaimer & Acknowledgments

This tool was created as an experimental utility to help the Waze editing community handle complex polygon tasks a bit more easily. It is provided as-is. Please always review your shapes and geometry within WME before saving your edits to ensure they meet local editing guidelines and standards. 

Feedback, bug reports, and community contributions are always welcome and appreciated.
