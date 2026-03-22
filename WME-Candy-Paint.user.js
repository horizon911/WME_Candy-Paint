// ==UserScript==
// @name         WME Candy paint
// @namespace       https://github.com/horizon911
// @version         2026.03.21.1
// @description  Interactive Master Layer Dragging, Shape Popping/Reverting, FPS Monitor, Bug Fixes.
// @match        https://*.waze.com/*/editor*
// @match        https://*.waze.com/editor*
// @icon            https://raw.githubusercontent.com/microsoft/fluentui-emoji/main/assets/Lollipop/Flat/lollipop_flat.svg
// @require      https://unpkg.com/polygon-clipping@0.15.3/dist/polygon-clipping.umd.js
// @require      https://cdn.jsdelivr.net/gh/WazeSpace/wme-sdk-plus@main/dist/wme-sdk-plus.js
// @grant        none
// @updateURL       https://update.greasyfork.org/scripts/570596/WME%20Reload%20Map%20Position%20Fix%20%28Candy%20Remix%29.user.js
// @downloadURL     https://update.greasyfork.org/scripts/570596/WME%20Reload%20Map%20Position%20Fix%20%28Candy%20Remix%29.user.js
// @license         GPLv3
// @supportURL      https://github.com/horizon911/WME_Candy-Paint/issues
// ==/UserScript==

(function() {
    'use strict';

    let wmeSDK;
    let canvasElement, ctx;
    let renderFrameRequested = false;

    // FPS Tracking State
    let fpsFrames = 0;
    let fpsLastTime = performance.now();

    // Core Geometry States
    let masterPolygons = []; // MultiPolygon: [ [ [ [lon, lat], ... ] ], ... ]
    let tempVertices = [];

    // Draft Mode States
    let draftVertices = [];
    let draftAction = 'none';
    let dragStartMouse = null;
    let dragStartGlobalCoords = null;
    let dragStartBBox = null;
    let currentMousePixel = null;
    let isDrawingShape = false;

    // Advanced Tool States
    let dragStartMasterPixels = null;
    let hoveredMasterPolyIndex = -1;
    let revertOriginalPolygon = null;

    // --- CENTRALIZED STATE MACHINE ---
    const appState = {
        tool: 'pan',
        mode: 'replace',
        brushSize: 10,
        wandTolerance: 50,
        brushStyle: 'freehand',
        cutterStyle: 'straight',
        targetVenueObj: null,
        targetVenueId: null,
        isDraftActive: false
    };

    // --- 1. BOOTSTRAP & WME SDK INITIALIZATION ---
    function bootstrap() {
        if (window.W && window.W.loginManager && window.W.loginManager.user && window.W.map) {
            initScript();
        } else {
            document.addEventListener("wme-ready", initScript, { once: true });
            setTimeout(bootstrap, 1000);
        }
    }

    function initScript() {
        wmeSDK = window.getWmeSdk({ scriptId: "wme-paint-net-overhaul", scriptName: "WME Paint.NET" });

        injectCanvasOverlay();
        createRefactoredUI();
        createTrackerHUD();

        wmeSDK.Events.on({ eventName: 'wme-selection-changed', eventHandler: handleSelectionChange });
        if (window.W && window.W.selectionManager) {
            window.W.selectionManager.events.register("selectionchanged", null, handleSelectionChange);
        }

        if (window.W && window.W.map && window.W.map.events) {
            window.W.map.events.register("move", null, updateCanvasOnMapChange);
            window.W.map.events.register("zoomend", null, updateCanvasOnMapChange);
        }

        if (window.W && window.W.map && typeof window.W.map.updateSize === 'function') {
            setTimeout(() => {
                window.W.map.updateSize();
                window.dispatchEvent(new Event('resize'));
            }, 800);
        }

        requestAnimationFrame(trackFPS);
        logToUI("Phase 16.9 Online. UI & Geometry fixes applied.");
        handleSelectionChange();
    }

    function trackFPS(now) {
        fpsFrames++;
        if (now - fpsLastTime >= 1000) {
            const fpsEl = document.getElementById('hud-fps-val');
            if (fpsEl) {
                fpsEl.innerText = fpsFrames;
                if (fpsFrames >= 45) fpsEl.style.color = '#26CC9A';
                else if (fpsFrames >= 25) fpsEl.style.color = '#FFC000';
                else fpsEl.style.color = '#FF5B5B';
            }
            fpsFrames = 0;
            fpsLastTime = now;
        }
        requestAnimationFrame(trackFPS);
    }

    // --- 2. STATE MACHINE MANAGERS ---
    function changeTool(newTool) {
        appState.tool = newTool;

        if (newTool === 'pan') {
            canvasElement.style.pointerEvents = 'none';
        } else {
            canvasElement.style.pointerEvents = 'auto';
        }

        isDrawingShape = false;
        tempVertices = [];
        hoveredMasterPolyIndex = -1;

        document.querySelectorAll('.wpo-btn-tool').forEach(btn => {
            btn.classList.toggle('active', btn.getAttribute('data-tool') === newTool);
        });

        renderOptionsRow();
        requestRender();
        updateTrackerHUD();
        logToUI(`Tool: ${newTool}`);
    }

    function changeMode(newMode) {
        appState.mode = newMode;
        document.querySelectorAll('.wpo-btn-mode').forEach(btn => {
            btn.classList.toggle('active', btn.getAttribute('data-val') === newMode);
        });
        requestRender();
    }

    function setDraftActive(state) {
        appState.isDraftActive = state;
        if (!state) draftVertices = [];
        renderOptionsRow();
    }

    function handleSelectionChange() {
        const models = getSelectedAreaVenues();
        const ingestBtn = document.getElementById('wpo-btn-ingest');
        const targetText = document.getElementById('wpo-target-text');

        if (models.length > 0) {
            appState.targetVenueObj = models[0];
            appState.targetVenueId = models[0].attributes.id || "New Polygon";
            targetText.innerHTML = `Target: <span style="color:#00A1F1; font-weight:bold;">${appState.targetVenueId}</span>`;
            ingestBtn.disabled = false;
            ingestBtn.style.opacity = '1';
            ingestBtn.style.cursor = 'pointer';
        } else {
            appState.targetVenueObj = null;
            appState.targetVenueId = null;
            targetText.innerHTML = `Target: <em>None</em>`;
            ingestBtn.disabled = true;
            ingestBtn.style.opacity = '0.5';
            ingestBtn.style.cursor = 'not-allowed';
        }
    }

    // --- 3. UI GENERATION (HTML/CSS INJECTION) ---
    function injectStyles() {
        if(document.getElementById('wpo-styles')) return;
        const style = document.createElement('style');
        style.id = 'wpo-styles';
        style.innerHTML = `
            #wme-paint-palette { position: fixed; top: 100px; right: 50px; width: auto; min-width: 310px; z-index: 9999999; background: #ffffff; border: 1px solid #c2c9d1; border-radius: 6px; box-shadow: 0 4px 15px rgba(0,0,0,0.15); font-family: "Helvetica Neue", Helvetica, "Boing", Arial, sans-serif; display: flex; flex-direction: column; overflow: hidden; color: #333; white-space: nowrap; }
            .wpo-header { background: #00A1F1; color: #fff; padding: 5px 8px; font-size: 13px; font-weight: bold; cursor: move; user-select: none; display: flex; justify-content: space-between; align-items: center; }
            .wpo-hdr-btn { background: transparent; border: none; color: #fff; cursor: pointer; opacity: 0.7; margin-left: 6px; font-size: 13px; padding: 0 3px; }
            .wpo-hdr-btn:hover { opacity: 1; }
            .wpo-body { padding: 6px; display: flex; flex-direction: column; gap: 5px; }
            .wpo-row { display: flex; align-items: center; width: 100%; }
            .wpo-target-row { justify-content: space-between; border-bottom: 1px solid #e0e4e8; padding-bottom: 5px; }
            .wpo-tool-row { background: #f0f2f5; border-radius: 4px; padding: 3px; flex-wrap: nowrap; gap: 2px; border: 1px solid #e0e4e8; }
            .wpo-options-row { background: #f0f2f5; border-radius: 4px; padding: 3px 6px; min-height: 28px; border: 1px solid #e0e4e8; justify-content: space-between; transition: all 0.2s; }
            .wpo-actions-row { justify-content: flex-end; gap: 3px; }
            .wpo-tool-group { display: flex; gap: 1px; border-right: 1px solid #c2c9d1; padding-right: 3px; margin-right: 2px; }
            .wpo-tool-group:last-child { border-right: none; padding-right: 0; margin-right: 0; }

            .wpo-btn { border: 1px solid transparent; background: transparent; padding: 4px 6px; cursor: pointer; border-radius: 4px; color: #495057; font-size: 13px; transition: all 0.15s ease-in-out; display: flex; align-items: center; justify-content: center; }
            .wpo-btn:hover:not(:disabled) { background: #e0e4e8; }
            .wpo-btn:disabled { opacity: 0.5; cursor: not-allowed; }
            .wpo-btn.active { background: #00A1F1; color: white; box-shadow: inset 0 2px 4px rgba(0,0,0,0.1); border-color: #0084C9; }

            .wpo-icon-only { background: transparent; border: none; cursor: pointer; font-size: 16px; opacity: 0.7; transition: all 0.2s; display: flex; align-items: center; justify-content: center; padding: 2px 6px; }
            .wpo-icon-only:hover:not(:disabled) { opacity: 1; transform: scale(1.1); }
            .wpo-icon-only:disabled { opacity: 0.3 !important; cursor: not-allowed !important; color: #999 !important; transform: none !important; filter: grayscale(100%); }
            .wpo-icon-success { color: #26CC9A; }
            .wpo-icon-danger { color: #FF5B5B; }

            .wpo-btn-action { font-size: 11px; font-weight: bold; padding: 4px 8px; gap: 4px; border: 1px solid #c2c9d1; background: #fff; border-radius: 4px; }
            .wpo-btn-action:hover:not(:disabled) { background: #f4f6f8; }
            .wpo-btn-success { background: #26CC9A; color: white; border-color: #1FB386; }
            .wpo-btn-success:hover:not(:disabled) { background: #1FB386; }

            .wpo-slider-container { display: flex; align-items: center; gap: 5px; font-size: 11px; color: #555; font-weight: bold; }
            .wpo-slider { width: 70px; margin: 0; }
            #wme-paint-log { height: 60px; overflow-y: auto; background: #212529; color:#fff; border-radius: 3px; padding: 4px; font-family: monospace; font-size: 10px; margin-top: 2px; border: 1px inset #555; }

            @keyframes wpo-pulse { 0% { opacity: 1; } 50% { opacity: 0.2; } 100% { opacity: 1; } }
            .wpo-blinking-dot { display: inline-block; width: 8px; height: 8px; background-color: #FF5B5B; border-radius: 50%; animation: wpo-pulse 1.5s infinite; }
        `;
        document.head.appendChild(style);
    }

    function createRefactoredUI() {
        if(document.getElementById('wme-paint-palette')) return;
        injectStyles();

        const palette = document.createElement('div');
        palette.id = 'wme-paint-palette';

        palette.innerHTML = `
            <div id="wpo-header" class="wpo-header">
                <div><i class="fa fa-paint-brush"></i> Paint.NET v16.9</div>
                <div>
                    <button id="wpo-toggle-tracker" class="wpo-hdr-btn" title="Toggle Tracker"><i class="fa fa-bug"></i></button>
                    <button id="wpo-toggle-log" class="wpo-hdr-btn" title="Toggle Console"><i class="fa fa-terminal"></i></button>
                </div>
            </div>
            <div class="wpo-body">
                <div class="wpo-row wpo-target-row">
                    <div style="display:flex; gap: 4px;">
                        <button id="wpo-btn-ingest" class="wpo-btn wpo-btn-action" title="Ingest selected WME Venue"><i class="fa fa-download"></i> Ingest</button>
                        <button id="wpo-btn-apply" class="wpo-btn wpo-btn-action wpo-btn-success" title="Apply shapes to WME"><i class="fa fa-check"></i> Apply</button>
                    </div>
                    <div id="wpo-target-text" style="font-size: 11px; color: #6c757d;">Target: <em>None</em></div>
                </div>

                <div class="wpo-row wpo-tool-row">
                    <div class="wpo-tool-group">
                        <button class="wpo-btn wpo-btn-tool active" data-tool="pan" title="Pan Map"><i class="fa fa-hand-paper-o"></i></button>
                    </div>
                    <div class="wpo-tool-group">
                        <button class="wpo-btn wpo-btn-tool" data-tool="measure" title="Measure Geodesic Distance"><i class="fa fa-arrows-h"></i></button>
                        <button class="wpo-btn wpo-btn-tool" data-tool="move" title="Move Master Layer"><i class="fa fa-arrows"></i></button>
                        <button class="wpo-btn wpo-btn-tool" data-tool="revert" title="Shape Shifter (Pop to Draft)"><i class="fa fa-history"></i></button>
                    </div>
                    <div class="wpo-tool-group">
                        <button class="wpo-btn wpo-btn-tool" data-tool="rectangle" title="Rectangle"><i class="fa fa-square-o"></i></button>
                        <button class="wpo-btn wpo-btn-tool" data-tool="ellipse" title="Ellipse"><i class="fa fa-circle-o"></i></button>
                        <button class="wpo-btn wpo-btn-tool" data-tool="lasso" title="Lasso"><i class="fa fa-pencil"></i></button>
                        <button class="wpo-btn wpo-btn-tool" data-tool="polygon" title="Polygon"><i class="fa fa-star-o"></i></button>
                    </div>
                    <div class="wpo-tool-group">
                        <button class="wpo-btn wpo-btn-tool" data-tool="brush" title="Paintbrush"><i class="fa fa-paint-brush"></i></button>
                        <button class="wpo-btn wpo-btn-tool" data-tool="eraser" title="Eraser"><i class="fa fa-eraser"></i></button>
                        <button class="wpo-btn wpo-btn-tool" data-tool="cutter" title="Cutter"><i class="fa fa-scissors"></i></button>
                        <button class="wpo-btn wpo-btn-tool" data-tool="wand" title="Magic Wand"><i class="fa fa-magic"></i></button>
                    </div>
                </div>

                <div id="wpo-options-row" class="wpo-row wpo-options-row"></div>

                <div class="wpo-row wpo-actions-row">
                    <button id="wpo-btn-clear" class="wpo-btn wpo-btn-action" title="Wipe entire canvas"><i class="fa fa-trash"></i> Clear</button>
                </div>
                <div id="wme-paint-log"></div>
            </div>
        `;
        document.body.appendChild(palette);

        const header = document.getElementById('wpo-header');
        let isDragging = false, currentX, currentY, initialX, initialY, xOffset = 0, yOffset = 0;
        header.addEventListener("mousedown", e => { if(e.target === header || e.target.parentNode === header) { initialX = e.clientX - xOffset; initialY = e.clientY - yOffset; isDragging = true; } });
        document.addEventListener("mouseup", () => { initialX = currentX; initialY = currentY; isDragging = false; });
        document.addEventListener("mousemove", e => {
            if (isDragging) { e.preventDefault(); currentX = e.clientX - initialX; currentY = e.clientY - initialY; xOffset = currentX; yOffset = currentY; palette.style.transform = `translate(${currentX}px, ${currentY}px)`; }
        });

        document.getElementById('wpo-toggle-tracker').onclick = () => {
            const trk = document.getElementById('wme-paint-hud');
            if(trk) trk.style.display = (trk.style.display === 'none') ? 'block' : 'none';
        };
        document.getElementById('wpo-toggle-log').onclick = () => {
            const lg = document.getElementById('wme-paint-log');
            if(lg) lg.style.display = (lg.style.display === 'none') ? 'block' : 'none';
        };

        document.getElementById('wpo-btn-ingest').onclick = ingestWmeSelection;
        document.getElementById('wpo-btn-apply').onclick = injectToWaze;
        document.getElementById('wpo-btn-clear').onclick = clearCanvasState;

        document.querySelectorAll('.wpo-btn-tool').forEach(btn => {
            btn.addEventListener('click', (e) => changeTool(e.currentTarget.getAttribute('data-tool')));
        });

        renderOptionsRow();
    }

    function renderOptionsRow() {
        const container = document.getElementById('wpo-options-row');
        let optionsHtml = '';
        const shapeTools = ['rectangle', 'ellipse', 'polygon', 'lasso', 'move', 'revert'];
        const draftCapableTools = ['revert', 'rectangle', 'ellipse', 'lasso', 'polygon', 'brush', 'wand'];

        if (appState.tool === 'pan') {
            optionsHtml = `<span style="font-size: 10px; color:#6c757d; width:100%; text-align:center;">Pan mode active.</span>`;
        } else if (appState.tool === 'measure') {
            optionsHtml = `<span style="font-size: 10px; color:#6c757d; width:100%; text-align:center;">Click and drag to measure distance.</span>`;
        } else if (appState.tool === 'move') {
            optionsHtml = `<span style="font-size: 10px; color:#6c757d; width:100%; text-align:center;">Click and drag to move the master layer.</span>`;
        } else if (appState.tool === 'revert' && !appState.isDraftActive) {
            optionsHtml = `<span style="font-size: 10px; color:#6c757d; width:100%; text-align:center;">Click a shape to pop it into Draft mode.</span>`;
        } else if (shapeTools.includes(appState.tool)) {
            optionsHtml = `
                <div style="display:flex; gap: 1px;">
                    <button class="wpo-btn wpo-btn-mode ${appState.mode==='replace'?'active':''}" data-val="replace" title="Replace"><i class="fa fa-file-o"></i></button>
                    <button class="wpo-btn wpo-btn-mode ${appState.mode==='union'?'active':''}" data-val="union" title="Add / Union"><i class="fa fa-plus"></i></button>
                    <button class="wpo-btn wpo-btn-mode ${appState.mode==='difference'?'active':''}" data-val="difference" title="Subtract"><i class="fa fa-minus"></i></button>
                    <button class="wpo-btn wpo-btn-mode ${appState.mode==='intersection'?'active':''}" data-val="intersection" title="Intersect"><i class="fa fa-pie-chart"></i></button>
                    <button class="wpo-btn wpo-btn-mode ${appState.mode==='xor'?'active':''}" data-val="xor" title="XOR"><i class="fa fa-exchange"></i></button>
                </div>
            `;
        } else if (appState.tool === 'brush' || appState.tool === 'eraser') {
            optionsHtml = `
                <div class="wpo-slider-container">
                    <span>Size:</span>
                    <input type="range" class="wpo-slider" id="wpo-brush-size" min="1" max="100" value="${appState.brushSize}">
                    <span id="wpo-brush-size-val" style="width:18px; text-align:right;">${appState.brushSize}</span>
                    <select id="wpo-brush-style" style="margin-left:3px; padding:1px; font-size:10px; border:1px solid #c2c9d1; border-radius:3px;">
                        <option value="freehand" ${appState.brushStyle==='freehand'?'selected':''}>Freehand</option>
                        <option value="line" ${appState.brushStyle==='line'?'selected':''}>Line</option>
                    </select>
                </div>
            `;
        } else if (appState.tool === 'wand') {
            optionsHtml = `
                <div class="wpo-slider-container">
                    <span>Tol:</span>
                    <input type="range" class="wpo-slider" id="wpo-wand-tol" min="0" max="100" value="${appState.wandTolerance}">
                    <span id="wpo-wand-tol-val" style="width:18px; text-align:right;">${appState.wandTolerance}</span>
                </div>
            `;
        } else if (appState.tool === 'cutter') {
            optionsHtml = `
                <div class="wpo-slider-container">
                    <span style="margin-right:4px;">Style:</span>
                    <select id="wpo-cutter-style" style="padding:1px; font-size:10px; border:1px solid #c2c9d1; border-radius:3px;">
                        <option value="straight" ${appState.cutterStyle==='straight'?'selected':''}>Straight Line</option>
                        <option value="freehand" ${appState.cutterStyle==='freehand'?'selected':''}>Freehand</option>
                    </select>
                </div>
            `;
        }

        if (draftCapableTools.includes(appState.tool)) {
            let disabledAttr = appState.isDraftActive ? '' : 'disabled';
            let draftButtons = `
                <div style="display:flex; gap: 6px; border-left: 1px solid #c2c9d1; padding-left: 8px; margin-left: auto;">
                    <button class="wpo-icon-only wpo-icon-success" id="wpo-opt-finish" title="Commit Draft (Enter)" ${disabledAttr}><i class="fa fa-check"></i></button>
                    <button class="wpo-icon-only wpo-icon-danger" id="wpo-opt-cancel" title="Discard Draft (Esc)" ${disabledAttr}><i class="fa fa-times"></i></button>
                </div>
            `;
            container.innerHTML = `<div style="display:flex; align-items:center; width:100%;">` + optionsHtml + draftButtons + `</div>`;

            document.getElementById('wpo-opt-finish').onclick = () => {
                if (appState.isDraftActive) { commitDraft(); requestRender(); updateTrackerHUD(); }
            };
            document.getElementById('wpo-opt-cancel').onclick = () => {
                if (appState.isDraftActive || revertOriginalPolygon || isDrawingShape || tempVertices.length > 0) {
                    cancelDraft(); requestRender(); updateTrackerHUD();
                }
            };
        } else {
            container.innerHTML = `<div style="display:flex; align-items:center; width:100%; justify-content:center;">${optionsHtml}</div>`;
        }

        container.querySelectorAll('.wpo-btn-mode').forEach(btn => {
            btn.onclick = (e) => changeMode(e.currentTarget.getAttribute('data-val'));
        });
        if (document.getElementById('wpo-brush-size')) {
            document.getElementById('wpo-brush-size').oninput = (e) => { appState.brushSize = e.target.value; document.getElementById('wpo-brush-size-val').innerText = appState.brushSize; };
            document.getElementById('wpo-brush-style').onchange = (e) => appState.brushStyle = e.target.value;
        }
        if (document.getElementById('wpo-wand-tol')) {
            document.getElementById('wpo-wand-tol').oninput = (e) => { appState.wandTolerance = e.target.value; document.getElementById('wpo-wand-tol-val').innerText = appState.wandTolerance; };
        }
        if (document.getElementById('wpo-cutter-style')) {
            document.getElementById('wpo-cutter-style').onchange = (e) => appState.cutterStyle = e.target.value;
        }
    }

    function createTrackerHUD() {
        if(document.getElementById('wme-paint-hud')) return;
        const hud = document.createElement('div');
        hud.id = 'wme-paint-hud';
        hud.style.cssText = 'position:fixed; bottom:30px; right:350px; background:rgba(0,0,0,0.85); color:#00A1F1; padding:8px; font-family:monospace; font-size:11px; z-index:9999999; border-radius:4px; border:1px solid #00A1F1; min-width:210px; pointer-events:auto; display:block;';

        hud.innerHTML = `
            <div id="wme-paint-hud-header" style="font-weight:bold; margin-bottom:4px; color:#fff; font-size:11px; cursor:move; padding-bottom:3px; border-bottom:1px solid #555; display:flex; align-items:center;">
                <i class="fa fa-crosshairs" style="margin-right:4px;"></i> Geo-Math Tracker
                <div style="margin-left:auto; display:flex; align-items:center; gap:6px;">
                    <span style="font-size:9px; color:#888; font-weight:normal;">FPS: <span id="hud-fps-val" style="color:#26CC9A; font-weight:bold;">0</span></span>
                    <span class="wpo-blinking-dot"></span>
                </div>
            </div>
            <div style="color: #26CC9A; font-weight:bold; margin-top:4px;">-- LIVE DATA --</div>
            <div>Px: [<span id="hud-px" style="color:#fff;">0, 0</span>]</div>
            <div>Geo: [<span id="hud-gps" style="color:#fff;">0.00000, 0.00000</span>]</div>
            <div style="margin-top:2px;">Layer: <span id="hud-layer" style="color:#FFC000;">None</span></div>
            <div style="margin-top: 6px; border-top: 1px solid #00A1F1; padding-top: 4px;">
                <span style="color:#26CC9A; font-weight:bold;">-- GEOMETRY --</span>
                <div id="hud-geo-math" style="color: #FFC000; margin-top: 2px;"><em>No shape active</em></div>
            </div>
        `;
        document.body.appendChild(hud);

        const hudHeader = document.getElementById('wme-paint-hud-header');
        let isDraggingHud = false, curHudX, curHudY, initHudX, initHudY, xHudOffset = 0, yHudOffset = 0;
        hudHeader.addEventListener("mousedown", e => { initHudX = e.clientX - xHudOffset; initHudY = e.clientY - yHudOffset; isDraggingHud = true; });
        document.addEventListener("mouseup", () => { initHudX = curHudX; initHudY = curHudY; isDraggingHud = false; });
        document.addEventListener("mousemove", e => {
            if (isDraggingHud) { e.preventDefault(); curHudX = e.clientX - initHudX; curHudY = e.clientY - initHudY; xHudOffset = curHudX; yHudOffset = curHudY; hud.style.transform = `translate(${curHudX}px, ${curHudY}px)`; }
        });
    }

    // --- 4. CANVAS INJECTION & EVENTS ---
    function injectCanvasOverlay() {
        if (document.getElementById('wme-paint-overlay')) return;

        const canvasContainer = document.createElement('div');
        canvasContainer.id = 'wme-paint-overlay';
        canvasContainer.style.cssText = 'position:fixed; top:0; left:0; width:100vw; height:100vh; z-index:999998; pointer-events:none;';

        canvasElement = document.createElement('canvas');
        canvasElement.id = 'native-paint-canvas';
        canvasElement.style.cssText = 'width:100%; height:100%; pointer-events:none;';

        canvasContainer.appendChild(canvasElement);
        document.body.appendChild(canvasContainer);
        ctx = canvasElement.getContext('2d');

        syncCanvasSize();
        setupDrawingEvents();
        window.addEventListener('resize', syncCanvasSize);
    }

    function syncCanvasSize() {
        if (!canvasElement) return;
        canvasElement.width = window.innerWidth;
        canvasElement.height = window.innerHeight;
        requestRender();
    }

    function updateCanvasOnMapChange() {
        requestRender();
        updateTrackerHUD();
    }

    function requestRender() {
        if (!renderFrameRequested) {
            renderFrameRequested = true;
            requestAnimationFrame(() => {
                renderCanvas();
                renderFrameRequested = false;
            });
        }
    }

    function setupDrawingEvents() {
        canvasElement.addEventListener('wheel', function(e) {
            if (appState.tool === 'pan') return;
            e.preventDefault();
            canvasElement.style.pointerEvents = 'none';
            let target = document.elementFromPoint(e.clientX, e.clientY);
            let wheelEvent = new WheelEvent('wheel', { clientX: e.clientX, clientY: e.clientY, deltaY: e.deltaY, deltaX: e.deltaX, deltaMode: e.deltaMode, bubbles: true, cancelable: true });
            if (target) target.dispatchEvent(wheelEvent);
            canvasElement.style.pointerEvents = 'auto';
        });

        canvasElement.addEventListener('mousedown', function(e) {
            if (appState.tool === 'pan') return;
            const gps = globalPixelToGps(e.clientX, e.clientY);
            if (!gps) return;

            // Handle Active Draft Manipulations
            if (appState.isDraftActive) {
                let hit = getDraftHitRegion(e.clientX, e.clientY);
                if (hit) {
                    draftAction = hit;
                    dragStartMouse = { x: e.clientX, y: e.clientY };
                    dragStartGlobalCoords = draftVertices.map(v => gpsToGlobalPixel(v.lon, v.lat));
                    dragStartBBox = getDraftBBox();
                    return;
                } else if (appState.tool !== 'revert') {
                    commitDraft();
                } else {
                    return;
                }
            }

            // Move Tool Logic
            if (appState.tool === 'move') {
                if (masterPolygons.length > 0) {
                    isDrawingShape = true;
                    dragStartMouse = { x: e.clientX, y: e.clientY };
                    dragStartMasterPixels = masterPolygons.map(poly =>
                        poly.map(ring =>
                            ring.map(pt => gpsToGlobalPixel(pt[0], pt[1]))
                        )
                    );
                }
            }
            // Shape Shifter (Revert) Logic
            else if (appState.tool === 'revert' && !appState.isDraftActive) {
                if (hoveredMasterPolyIndex !== -1 && masterPolygons[hoveredMasterPolyIndex]) {
                    let poppedPoly = masterPolygons.splice(hoveredMasterPolyIndex, 1)[0];
                    revertOriginalPolygon = [poppedPoly];
                    draftVertices = poppedPoly[0].map(pt => ({lon: pt[0], lat: pt[1]}));
                    setDraftActive(true);
                    logToUI("Shape popped to draft.");
                }
            }
            // Standard Tools
            else if (appState.tool === 'polygon') {
                tempVertices.push(gps);
            } else if (appState.tool === 'measure') {
                tempVertices = [gps, gps];
                isDrawingShape = true;
            } else {
                isDrawingShape = true;
                tempVertices = [gps];
                dragStartMouse = { x: e.clientX, y: e.clientY };
            }
            requestRender();
            updateTrackerHUD();
        });

        canvasElement.addEventListener('mousemove', function(e) {
            currentMousePixel = { x: e.clientX, y: e.clientY };
            requestAnimationFrame(() => updateLiveMouseHUD(currentMousePixel));

            if (appState.tool === 'pan') return;

            if (draftAction !== 'none') {
                executeDraftTransform(e.clientX, e.clientY);
            } else if (appState.isDraftActive) {
                let hit = getDraftHitRegion(e.clientX, e.clientY);
                canvasElement.style.cursor = getCursorForHit(hit);
            } else if (appState.tool === 'move' && isDrawingShape && dragStartMasterPixels) {
                let dx = e.clientX - dragStartMouse.x;
                let dy = e.clientY - dragStartMouse.y;
                masterPolygons = dragStartMasterPixels.map(poly =>
                    poly.map(ring =>
                        ring.map(px => {
                            if(!px) return [0,0];
                            let newGps = globalPixelToGps(px.x + dx, px.y + dy);
                            return newGps ? [newGps.lon, newGps.lat] : [0,0];
                        })
                    )
                );
            } else if (appState.tool === 'revert' && !appState.isDraftActive) {
                hoveredMasterPolyIndex = -1;
                canvasElement.style.cursor = 'crosshair';
                for (let i = masterPolygons.length - 1; i >= 0; i--) {
                    if (!masterPolygons[i]) continue;
                    ctx.beginPath();
                    masterPolygons[i].forEach(ring => {
                        ring.forEach((pt, idx) => {
                            let px = gpsToGlobalPixel(pt[0], pt[1]);
                            if (px) idx === 0 ? ctx.moveTo(px.x, px.y) : ctx.lineTo(px.x, px.y);
                        });
                    });
                    if (ctx.isPointInPath(currentMousePixel.x, currentMousePixel.y, 'evenodd')) {
                        hoveredMasterPolyIndex = i;
                        canvasElement.style.cursor = 'pointer';
                        break;
                    }
                }
            } else if (isDrawingShape) {
                const gps = globalPixelToGps(e.clientX, e.clientY);
                const startGps = globalPixelToGps(dragStartMouse ? dragStartMouse.x : e.clientX, dragStartMouse ? dragStartMouse.y : e.clientY);

                if (gps && appState.tool === 'measure') {
                    tempVertices[1] = gps;
                } else if (gps && startGps) {
                    if (appState.tool === 'rectangle') tempVertices = generateRectangle(startGps, gps);
                    else if (appState.tool === 'ellipse') tempVertices = generateEllipse(startGps, gps);
                    else if (appState.tool === 'lasso') {
                        let last = tempVertices[tempVertices.length-1];
                        if (Math.abs(gps.lon - last.lon) > 0.00005 || Math.abs(gps.lat - last.lat) > 0.00005) {
                            tempVertices.push(gps);
                        }
                    }
                }
            }
            requestRender();
            if (isDrawingShape || draftAction !== 'none') updateTrackerHUD();
        });

        canvasElement.addEventListener('mouseup', function(e) {
            if (appState.tool === 'pan') return;

            if (draftAction !== 'none') {
                draftAction = 'none';
            } else if (appState.tool === 'move') {
                isDrawingShape = false;
                dragStartMasterPixels = null;
            } else if (appState.tool === 'measure') {
                isDrawingShape = false;
            } else if (isDrawingShape && appState.tool !== 'polygon' && appState.tool !== 'revert') {
                isDrawingShape = false;
                if (tempVertices.length > 2) {
                    draftVertices = [...tempVertices];
                    setDraftActive(true);
                    logToUI("Draft ready.");
                }
                tempVertices = [];
            }
            requestRender();
            updateTrackerHUD();
        });

        canvasElement.addEventListener('dblclick', function(e) {
            if (appState.tool === 'pan') return;
            if (appState.tool === 'polygon' && tempVertices.length > 2) {
                draftVertices = [...tempVertices];
                setDraftActive(true);
                tempVertices = [];
                logToUI("Polygon drafted.");
                requestRender();
                updateTrackerHUD();
            }
        });

        window.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') {
                cancelDraft(); requestRender(); updateTrackerHUD();
            } else if (e.key === 'Enter' && appState.isDraftActive && appState.tool !== 'pan') {
                commitDraft(); requestRender(); updateTrackerHUD();
            }
        });
    }

    // --- 5. LOGIC HELPERS & PURE MATH ---
    function logToUI(msg, isError = false) {
        const logBox = document.getElementById('wme-paint-log');
        if (logBox) {
            const time = new Date().toLocaleTimeString([], { hour12: false });
            const color = isError ? '#FF5B5B' : '#26CC9A';
            logBox.innerHTML += `<div style="color:${color};"><span style="color:#888;">[${time}]</span> ${msg}</div>`;
            logBox.scrollTop = logBox.scrollHeight;
        }
        console.log(`[WME Paint] ${msg}`);
    }

    function cancelDraft() {
        if (isDrawingShape || tempVertices.length > 0) {
            isDrawingShape = false; tempVertices = [];
        } else if (appState.isDraftActive) {
            if (revertOriginalPolygon) {
                masterPolygons.push(...revertOriginalPolygon);
                logToUI("Shape restored.");
            } else {
                logToUI("Draft cancelled.");
            }
            revertOriginalPolygon = null;
            setDraftActive(false);
        } else if (appState.tool !== 'pan') {
            changeTool('pan');
        }
    }

    function clearCanvasState() {
        masterPolygons = []; tempVertices = []; draftVertices = [];
        revertOriginalPolygon = null;
        setDraftActive(false); isDrawingShape = false;
        requestRender(); updateTrackerHUD();
        logToUI("Canvas Cleared.");
    }

    function formatLength(meters, isImperial) {
        if (isImperial) {
            let ft = meters * 3.28084;
            return (ft > 5280) ? (ft / 5280).toFixed(2) + ' mi' : ft.toFixed(1) + ' ft';
        } else {
            return (meters > 1000) ? (meters / 1000).toFixed(2) + ' km' : meters.toFixed(1) + ' m';
        }
    }

    function formatArea(sqMeters, isImperial) {
        if (isImperial) return Math.round(sqMeters * 10.7639).toLocaleString() + ' ft²';
        return Math.round(sqMeters).toLocaleString() + ' m²';
    }

    function getPixelArea(pts) {
        let area = 0;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
            area += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y);
        }
        return Math.abs(area / 2);
    }

    function wgs84ToMercator(lon, lat) {
        const x = (lon * 20037508.34) / 180;
        let y = Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) / (Math.PI / 180);
        return { x: x, y: (y * 20037508.34) / 180 };
    }

    function mercatorToWgs84(x, y) {
        const lon = (x / 20037508.34) * 180;
        const y_deg = (y / 20037508.34) * 180;
        return { lon: lon, lat: (180 / Math.PI) * (2 * Math.atan(Math.exp(y_deg * Math.PI / 180)) - Math.PI / 2) };
    }

    function globalPixelToGps(globalX, globalY) {
        const mapDiv = document.getElementById('map');
        if (!mapDiv || !window.W || !window.W.map || !wmeSDK) return null;

        const centerGps = wmeSDK.Map.getMapCenter();
        const res = window.W.map.getResolution();
        if (!centerGps || !res) return null;

        const mapRect = mapDiv.getBoundingClientRect();
        const localX = globalX - mapRect.left;
        const localY = globalY - mapRect.top;

        const centerMerc = wgs84ToMercator(centerGps.lon, centerGps.lat);
        const mapW = mapDiv.clientWidth;
        const mapH = mapDiv.clientHeight;

        const targetMercX = centerMerc.x + ((localX - (mapW / 2)) * res);
        const targetMercY = centerMerc.y - ((localY - (mapH / 2)) * res);

        return mercatorToWgs84(targetMercX, targetMercY);
    }

    function gpsToGlobalPixel(lon, lat) {
        const mapDiv = document.getElementById('map');
        if (!mapDiv || !window.W || !window.W.map || !wmeSDK) return null;

        const centerGps = wmeSDK.Map.getMapCenter();
        const res = window.W.map.getResolution();
        if (!centerGps || !res) return null;

        const targetMerc = wgs84ToMercator(lon, lat);
        const centerMerc = wgs84ToMercator(centerGps.lon, centerGps.lat);

        const mapW = mapDiv.clientWidth;
        const mapH = mapDiv.clientHeight;

        const localX = (mapW / 2) + ((targetMerc.x - centerMerc.x) / res);
        const localY = (mapH / 2) - ((targetMerc.y - centerMerc.y) / res);

        const mapRect = mapDiv.getBoundingClientRect();
        return { x: localX + mapRect.left, y: localY + mapRect.top };
    }

    function getHoveredFeatureName() {
        if (!window.W || !window.W.selectionManager || !window.W.selectionManager.hoveredItem) return "None";
        let m = window.W.selectionManager.hoveredItem.model || window.W.selectionManager.hoveredItem;
        return m.attributes?.name || m.type || "None";
    }

    function getSelectedAreaVenues() {
        let selected = [];
        if (!window.W || !window.W.selectionManager) return selected;
        let items = [];
        if (typeof window.W.selectionManager.getSelectedDataModelObjects === 'function') {
            items = window.W.selectionManager.getSelectedDataModelObjects();
        } else if (typeof window.W.selectionManager.getSelectedFeatures === 'function') {
            items = window.W.selectionManager.getSelectedFeatures();
        } else {
            items = window.W.selectionManager.selectedItems || [];
        }

        items.forEach(item => {
            let model = item.model || item;
            if (model && (model.type === 'venue' || model.type === 'landmark' || (model.attributes && model.attributes.categories))) {
                let isArea = false;
                if (typeof model.isPoint === 'function') {
                    isArea = !model.isPoint();
                } else if (model.geometry) {
                    isArea = (model.geometry.CLASS_NAME === "OpenLayers.Geometry.Polygon" || model.geometry.CLASS_NAME === "OpenLayers.Geometry.Collection");
                } else if (model.attributes?.geometry?.type === "Polygon") {
                    isArea = true;
                }
                if (isArea) selected.push(model);
            }
        });
        return selected;
    }

    function generateRectangle(p1, p2) { return [{ lon: p1.lon, lat: p1.lat }, { lon: p2.lon, lat: p1.lat }, { lon: p2.lon, lat: p2.lat }, { lon: p1.lon, lat: p2.lat }]; }
    function generateEllipse(center, edge) {
        const cM = wgs84ToMercator(center.lon, center.lat), eM = wgs84ToMercator(edge.lon, edge.lat);
        const radius = Math.hypot(eM.x - cM.x, eM.y - cM.y);
        let pts = [];
        for(let i=0; i<36; i++) pts.push(mercatorToWgs84(cM.x + radius * Math.cos((i/36)*Math.PI*2), cM.y + radius * Math.sin((i/36)*Math.PI*2)));
        return pts;
    }
    function getDraftBBox() {
        let pxs = draftVertices.map(v => gpsToGlobalPixel(v.lon, v.lat)).filter(p=>p);
        if(!pxs.length) return null;
        let xs = pxs.map(p => p.x), ys = pxs.map(p => p.y);
        return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
    }
    function getDraftHitRegion(x, y) {
        let b = getDraftBBox(); if (!b) return null;
        let cx = (b.minX + b.maxX)/2, cy = (b.minY + b.maxY)/2, H = 6;
        if (Math.hypot(x - cx, y - (b.minY - 25)) <= H*1.5) return 'rotate';
        if (Math.abs(x - b.minX) <= H && Math.abs(y - b.minY) <= H) return 'resize-nw';
        if (Math.abs(x - b.maxX) <= H && Math.abs(y - b.minY) <= H) return 'resize-ne';
        if (Math.abs(x - b.minX) <= H && Math.abs(y - b.maxY) <= H) return 'resize-sw';
        if (Math.abs(x - b.maxX) <= H && Math.abs(y - b.maxY) <= H) return 'resize-se';
        ctx.beginPath();
        draftVertices.forEach((v, i) => { let p = gpsToGlobalPixel(v.lon, v.lat); if (p) i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y); });
        ctx.closePath();
        if (ctx.isPointInPath(x, y)) return 'move';
        return null;
    }
    function getCursorForHit(hit) {
        if(hit==='rotate') return 'crosshair'; if(hit==='move') return 'move';
        if(hit==='resize-nw'||hit==='resize-se') return 'nwse-resize'; if(hit==='resize-ne'||hit==='resize-sw') return 'nesw-resize';
        return 'crosshair';
    }
    function executeDraftTransform(curX, curY) {
        let b = dragStartBBox, cx = (b.minX + b.maxX)/2, cy = (b.minY + b.maxY)/2;
        if (draftAction === 'move') {
            draftVertices = dragStartGlobalCoords.map(p => globalPixelToGps(p.x + (curX - dragStartMouse.x), p.y + (curY - dragStartMouse.y)));
        } else if (draftAction === 'rotate') {
            let da = Math.atan2(curY - cy, curX - cx) - Math.atan2(dragStartMouse.y - cy, dragStartMouse.x - cx);
            draftVertices = dragStartGlobalCoords.map(p => globalPixelToGps(cx + (p.x - cx)*Math.cos(da) - (p.y - cy)*Math.sin(da), cy + (p.x - cx)*Math.sin(da) + (p.y - cy)*Math.cos(da)));
        } else if (draftAction.startsWith('resize-')) {
            let h = draftAction.split('-')[1], origin = {x: cx, y: cy};
            if (h.includes('n')) origin.y = b.maxY; if (h.includes('s')) origin.y = b.minY;
            if (h.includes('w')) origin.x = b.maxX; if (h.includes('e')) origin.x = b.minX;
            let scaleX = Math.abs(curX - origin.x) / (Math.abs(dragStartMouse.x - origin.x) || 1), scaleY = Math.abs(curY - origin.y) / (Math.abs(dragStartMouse.y - origin.y) || 1);
            let signX = Math.sign(curX - origin.x) === Math.sign(dragStartMouse.x - origin.x) ? 1 : -1, signY = Math.sign(curY - origin.y) === Math.sign(dragStartMouse.y - origin.y) ? 1 : -1;
            draftVertices = dragStartGlobalCoords.map(p => globalPixelToGps(origin.x + (p.x - origin.x)*(scaleX*signX), origin.y + (p.y - origin.y)*(scaleY*signY)));
        }
    }
    function commitDraft() {
        if (!appState.isDraftActive || draftVertices.length < 3) return;
        let pts = draftVertices.map(v => [v.lon, v.lat]);
        if (pts[0][0] !== pts[pts.length-1][0] || pts[0][1] !== pts[pts.length-1][1]) pts.push([pts[0][0], pts[0][1]]);
        let drawnPoly = window.polygonClipping.union([[pts]]);
        try {
            if (appState.mode === 'replace' || masterPolygons.length === 0) masterPolygons = drawnPoly;
            else if (appState.mode === 'union') masterPolygons = window.polygonClipping.union(masterPolygons, drawnPoly);
            else if (appState.mode === 'difference') masterPolygons = window.polygonClipping.difference(masterPolygons, drawnPoly);
            else if (appState.mode === 'intersection') masterPolygons = window.polygonClipping.intersection(masterPolygons, drawnPoly);
            else if (appState.mode === 'xor') masterPolygons = window.polygonClipping.xor(masterPolygons, drawnPoly);
            logToUI(`Committed via ${appState.mode.toUpperCase()}`);
        } catch (e) { logToUI("Math Error. Crossed lines?", true); }

        revertOriginalPolygon = null;
        setDraftActive(false);
    }

    // --- 6. RENDERING & TRACKER MATH ---
    function renderCanvas() {
        if (!ctx || !canvasElement) return;
        ctx.clearRect(0, 0, canvasElement.width, canvasElement.height);

        if (appState.tool !== 'pan') {
            ctx.fillStyle = 'rgba(0, 0, 0, 0.05)';
            ctx.fillRect(0, 0, canvasElement.width, canvasElement.height);
        }

        if (appState.tool === 'measure' && tempVertices.length === 2) {
            let p1 = gpsToGlobalPixel(tempVertices[0].lon, tempVertices[0].lat);
            let p2 = gpsToGlobalPixel(tempVertices[1].lon, tempVertices[1].lat);
            if(p1 && p2) {
                let pxDist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
                let olPt1 = new window.OpenLayers.Geometry.Point(tempVertices[0].lon, tempVertices[0].lat);
                let olPt2 = new window.OpenLayers.Geometry.Point(tempVertices[1].lon, tempVertices[1].lat);
                olPt1.transform(new window.OpenLayers.Projection("EPSG:4326"), window.W.map.getProjectionObject());
                olPt2.transform(new window.OpenLayers.Projection("EPSG:4326"), window.W.map.getProjectionObject());
                let line = new window.OpenLayers.Geometry.LineString([olPt1, olPt2]);
                let realDist = line.getGeodesicLength(window.W.map.getProjectionObject());

                let isImp = window.W.prefs.attributes.isImperial;
                let realStr = formatLength(realDist, isImp);

                ctx.strokeStyle = '#FF5B5B'; ctx.lineWidth = 2; ctx.beginPath();
                ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();

                ctx.fillStyle = 'rgba(0,0,0,0.8)'; ctx.fillRect(p2.x + 10, p2.y + 10, 130, 40);
                ctx.fillStyle = '#fff'; ctx.font = '11px monospace';
                ctx.fillText(`Px: ${Math.round(pxDist)}`, p2.x + 15, p2.y + 25);
                ctx.fillText(`Geo: ${realStr}`, p2.x + 15, p2.y + 40);
            }
        }

        if (masterPolygons.length > 0) {
            let isReplacing = (appState.mode === 'replace') && (isDrawingShape || appState.isDraftActive || tempVertices.length > 0);
            ctx.fillStyle = isReplacing ? 'rgba(0, 161, 241, 0.1)' : 'rgba(0, 161, 241, 0.4)';
            ctx.strokeStyle = isReplacing ? 'rgba(0, 161, 241, 0.2)' : '#00A1F1';
            ctx.lineWidth = 2;

            for (let p = 0; p < masterPolygons.length; p++) {
                ctx.beginPath();
                for (let r = 0; r < masterPolygons[p].length; r++) {
                    let pts = masterPolygons[p][r];
                    for (let i = 0; i < pts.length; i++) {
                        let px = gpsToGlobalPixel(pts[i][0], pts[i][1]);
                        if (px) i === 0 ? ctx.moveTo(px.x, px.y) : ctx.lineTo(px.x, px.y);
                    }
                    ctx.closePath();
                }
                ctx.fill("evenodd"); ctx.stroke();
            }
        }

        // Shape Shifter Highlight (SAFETY CHECK ADDED)
        if (appState.tool === 'revert' && hoveredMasterPolyIndex !== -1 && !appState.isDraftActive) {
            const hoveredPoly = masterPolygons[hoveredMasterPolyIndex];
            if (hoveredPoly && Array.isArray(hoveredPoly)) {
                ctx.fillStyle = 'rgba(255, 200, 0, 0.5)';
                ctx.strokeStyle = '#FFC000';
                ctx.lineWidth = 3;
                ctx.beginPath();
                hoveredPoly.forEach(ring => {
                    ring.forEach((pt, idx) => {
                        let px = gpsToGlobalPixel(pt[0], pt[1]);
                        if (px) idx === 0 ? ctx.moveTo(px.x, px.y) : ctx.lineTo(px.x, px.y);
                    });
                });
                ctx.fill("evenodd"); ctx.stroke();
            }
        }

        let modeColor = appState.mode==='union'?'#26CC9A':appState.mode==='difference'?'#FF5B5B':appState.mode==='intersection'?'#FFC000':appState.mode==='xor'?'#a451fa':'#000';

        if (appState.isDraftActive && draftVertices.length > 0) {
            ctx.fillStyle = modeColor; ctx.globalAlpha = 0.3; ctx.beginPath();
            draftVertices.forEach((v, i) => { let px = gpsToGlobalPixel(v.lon, v.lat); if (px) i === 0 ? ctx.moveTo(px.x, px.y) : ctx.lineTo(px.x, px.y); });
            ctx.closePath(); ctx.fill(); ctx.globalAlpha = 1.0; ctx.strokeStyle = modeColor; ctx.stroke();

            let b = getDraftBBox();
            if (b) {
                ctx.setLineDash([4, 4]); ctx.strokeRect(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY); ctx.setLineDash([]);
                ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000';
                let cx = (b.minX+b.maxX)/2, cy = (b.minY+b.maxY)/2, H = 4;
                ctx.beginPath(); ctx.moveTo(cx, b.minY); ctx.lineTo(cx, b.minY - 25); ctx.stroke();
                ctx.beginPath(); ctx.arc(cx, b.minY - 25, 4, 0, Math.PI*2); ctx.fill(); ctx.stroke();
                [[b.minX, b.minY], [cx, b.minY], [b.maxX, b.minY], [b.maxX, cy], [b.maxX, b.maxY], [cx, b.maxY], [b.minX, b.maxY], [b.minX, cy]].forEach(p => { ctx.fillRect(p[0]-H, p[1]-H, H*2, H*2); ctx.strokeRect(p[0]-H, p[1]-H, H*2, H*2); });
            }
        }

        if (tempVertices.length > 0 && appState.tool !== 'measure') {
            ctx.strokeStyle = modeColor; ctx.lineWidth = 2; ctx.setLineDash([5, 5]); ctx.beginPath();
            for (let i = 0; i < tempVertices.length; i++) { let px = gpsToGlobalPixel(tempVertices[i].lon, tempVertices[i].lat); if (px) i === 0 ? ctx.moveTo(px.x, px.y) : ctx.lineTo(px.x, px.y); }
            if (appState.tool === 'polygon' && currentMousePixel) ctx.lineTo(currentMousePixel.x, currentMousePixel.y); else if (tempVertices.length > 2) ctx.closePath();
            ctx.stroke(); ctx.setLineDash([]);
        }
    }

    function updateLiveMouseHUD(globalPixel) {
        const hud = document.getElementById('wme-paint-hud');
        if (!hud || !globalPixel || hud.style.display === 'none') return;
        document.getElementById('hud-px').innerText = `${Math.round(globalPixel.x)}, ${Math.round(globalPixel.y)}`;
        const liveGps = globalPixelToGps(globalPixel.x, globalPixel.y);
        if (liveGps) {
            document.getElementById('hud-gps').innerText = `${liveGps.lon.toFixed(5)}, ${liveGps.lat.toFixed(5)}`;
            document.getElementById('hud-layer').innerText = getHoveredFeatureName();
        }
    }

    function updateTrackerHUD() {
        const hud = document.getElementById('wme-paint-hud');
        if (!hud || hud.style.display === 'none') return;

        let displayVertices = [];
        let isCircle = false;

        if (appState.isDraftActive) {
            displayVertices = draftVertices;
        } else if (isDrawingShape && tempVertices.length > 0) {
            displayVertices = tempVertices;
            if (appState.tool === 'ellipse') isCircle = true;
        } else if (masterPolygons.length > 0 && masterPolygons[0][0]) {
            displayVertices = masterPolygons[0][0].map(pt => ({lon: pt[0], lat: pt[1]}));
        }

        const geoContainer = document.getElementById('hud-geo-math');

        if (displayVertices.length < 3) {
            geoContainer.innerHTML = '<em>No shape active</em>';
            return;
        }

        try {
            const isImp = window.W.prefs.attributes.isImperial;
            let pxList = displayVertices.map(v => gpsToGlobalPixel(v.lon, v.lat)).filter(p=>p);
            let pxArea = getPixelArea(pxList);

            let olPts = displayVertices.map(v => {
                let pt = new window.OpenLayers.Geometry.Point(v.lon, v.lat);
                pt.transform(new window.OpenLayers.Projection("EPSG:4326"), window.W.map.getProjectionObject());
                return pt;
            });

            if(olPts[0].x !== olPts[olPts.length-1].x || olPts[0].y !== olPts[olPts.length-1].y) {
                olPts.push(olPts[0].clone());
            }

            let ring = new window.OpenLayers.Geometry.LinearRing(olPts);
            let poly = new window.OpenLayers.Geometry.Polygon([ring]);
            let geoArea = poly.getGeodesicArea(window.W.map.getProjectionObject());
            let geoPerimeter = ring.getGeodesicLength(window.W.map.getProjectionObject());

            if (isCircle) {
                let b = poly.getBounds();
                let geoRadius = (b.right - b.left) / 2;
                let pxRadiusText = "N/A";
                if(pxList.length > 0) {
                    let xs = pxList.map(p=>p.x); let w = Math.max(...xs) - Math.min(...xs);
                    pxRadiusText = `${Math.round(w/2)} px`;
                }

                geoContainer.innerHTML = `
                    <div>Radius: ${formatLength(geoRadius, isImp)} (${pxRadiusText})</div>
                    <div>Area: ${formatArea(geoArea, isImp)}</div>
                    <div>Px Area: ${Math.round(pxArea).toLocaleString()} px²</div>
                `;
            } else {
                geoContainer.innerHTML = `
                    <div>Area: ${formatArea(geoArea, isImp)}</div>
                    <div>Perimeter: ${formatLength(geoPerimeter, isImp)}</div>
                    <div>Px Area: ${Math.round(pxArea).toLocaleString()} px²</div>
                `;
            }
        } catch (e) {
            geoContainer.innerHTML = '<em style="color:#FF5B5B;">Calc Error</em>';
        }
    }

    // --- 7. WME I/O ---
    function ingestWmeSelection() {
        let models = getSelectedAreaVenues();
        if (models.length > 0) {
            let newPolys = models.map(m => {
                let geom = m.geometry.clone(); geom.transform(window.W.map.getProjectionObject(), new window.OpenLayers.Projection("EPSG:4326"));
                return [geom.components.map(c => c.components.map(pt => [pt.x, pt.y]))];
            });
            try {
                let combined = newPolys.reduce((acc, p) => window.polygonClipping.union(acc, p));
                masterPolygons = masterPolygons.length ? window.polygonClipping.union(masterPolygons, combined) : combined;
                logToUI(`Ingested ${models.length} Venue(s).`);
                if(appState.tool === 'pan') changeTool('polygon'); else { requestRender(); updateTrackerHUD(); }
            } catch(e) { logToUI(`Error ingesting.`, true); console.error(e); }
        }
    }

    function injectToWaze() {
        if (appState.isDraftActive) commitDraft();
        if (!masterPolygons.length) { logToUI("Nothing to inject.", true); return; }
        try {
            let updateCounter = 0;
            masterPolygons.forEach((poly, i) => {
                let olRings = poly.map(r => new window.OpenLayers.Geometry.LinearRing(r.map(p => { let pt = new window.OpenLayers.Geometry.Point(p[0], p[1]); pt.transform(new window.OpenLayers.Projection("EPSG:4326"), window.W.map.getProjectionObject()); return pt; })));
                let newGeom = new window.OpenLayers.Geometry.Polygon(olRings); newGeom.clearBounds();

                if (i === 0 && appState.targetVenueObj) {
                    window.W.model.actionManager.add(new (require("Waze/Action/UpdateFeatureGeometry"))(appState.targetVenueObj, window.W.model.venues, appState.targetVenueObj.geometry.clone(), newGeom));
                } else {
                    let newVenue = new (require("Waze/Feature/Vector/Landmark"))({}); newVenue.geometry = newGeom; newVenue.attributes.categories = ['OTHER'];
                    window.W.model.actionManager.add(new (require("Waze/Action/AddLandmark"))(newVenue));
                }
                updateCounter++;
            });
            logToUI(`Injected ${updateCounter} Venue(s)!`);
            changeTool('pan');
        } catch (e) { logToUI(`Injection Failed`, true); console.error(e); }
    }

    bootstrap();
})();
