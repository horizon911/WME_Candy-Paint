// ==UserScript==
// @name            WME Reload Map Position Fix (Candy Remix)
// @namespace       https://greasyfork.org/users/166843
// @description     Updates the browser URL dynamically as you move the map.
// @version         2026.03.13.2
// @author          Horizon911
// @contributor  dBsooner
// @match           https://www.waze.com/*editor*
// @match           https://beta.waze.com/*editor*
// @exclude         https://www.waze.com/user/editor*
// @icon            https://raw.githubusercontent.com/FortAwesome/Font-Awesome/6.x/svgs/solid/arrow-rotate-right.svg
// @grant           none
// @updateURL       https://update.greasyfork.org/scripts/570596/WME%20Reload%20Map%20Position%20Fix%20%28Candy%20Remix%29.user.js
// @downloadURL     https://update.greasyfork.org/scripts/570596/WME%20Reload%20Map%20Position%20Fix%20%28Candy%20Remix%29.user.js
// @license         GPLv3
// ==/UserScript==




(() => {
    'use strict';

    // Constants
    const SCRIPT_ID = 'wme-dynamic-url';
    const SCRIPT_NAME = 'WME Dynamic URL Fix';
    const UPDATE_DELAY_MS = 300;

    const VOLATILE_PARAMS = [
        'mapUpdateRequest', 'updateRequest', 'segments',
        'nodes', 'venues', 'cameras', 'mapComments'
    ];

    let wmeSDK = null;

    // Debounce utility to prevent history API spam
    const debounce = (func, wait) => {
        let timeout;
        return (...args) => {
            clearTimeout(timeout);
            timeout = setTimeout(() => func.apply(this, args), wait);
        };
    };

    // Core URL updating logic
    const updateUrlParams = () => {
        if (!wmeSDK) return;

        // Modern WME SDK natively returns WGS84 GPS degrees
        const center = wmeSDK.Map.getMapCenter();

        // Failsafe fallback
        const zoom = (typeof wmeSDK.Map.getZoom === 'function')
            ? wmeSDK.Map.getZoom()
            : window.W?.map?.getZoom();

        // Ensure we have valid data
        if (!center || typeof center.lon !== 'number' || typeof center.lat !== 'number' || zoom === undefined) return;

        const url = new URL(window.location.href);
        const { searchParams } = url;

        // Update GPS coordinates directly
        searchParams.set('lon', center.lon.toFixed(5));
        searchParams.set('lat', center.lat.toFixed(5));
        searchParams.set('zoomLevel', zoom);

        // Strip volatile parameters dynamically
        VOLATILE_PARAMS.forEach(param => searchParams.delete(param));

        // Safely update the address bar
        window.history.replaceState(null, '', `${url.pathname}?${searchParams.toString()}`);
    };

    // Wrap the update function in our debouncer
    const debouncedUpdate = debounce(updateUrlParams, UPDATE_DELAY_MS);

    // Initialization routine
    const initScript = () => {
        console.log(`%c${SCRIPT_NAME}:%c Initialized via WME SDK. Native WGS84 tracking active...`, 'color: #00A6D6; font-weight: bold;', '');

        try {
            // Retrieve the strict SDK instance
            wmeSDK = window.getWmeSdk({ scriptId: SCRIPT_ID, scriptName: SCRIPT_NAME });

            // Bind to map events using the modern SDK event layer
            wmeSDK.Events.on({ eventName: 'wme-map-move-end', eventHandler: debouncedUpdate });
            wmeSDK.Events.on({ eventName: 'wme-map-zoom-changed', eventHandler: debouncedUpdate });

        } catch (error) {
            console.error(`${SCRIPT_NAME}: SDK Initialization failed`, error);
        }
    };

    // Official SDK Bootstrap loader
    const bootstrap = () => {
        if (window.SDK_INITIALIZED) {
            window.SDK_INITIALIZED.then(initScript);
        } else {
            document.addEventListener('wme-ready', () => {
                if (window.getWmeSdk) initScript();
            }, { once: true });
        }
    };

    bootstrap();
})();
