# WME Reload Map Position Fix (Candy Remix)

This userscript augments the [Waze Map Editor](https://www.waze.com/editor/) by dynamically tracking your map position and seamlessly restoring it upon reloading. It is a modernized, performance-optimized continuation of dBsooner's original and highly useful script, updated to comply with the modern WME SDK.

## How to use

Once installed, the script works entirely in the background. As you pan and zoom across the Waze Map Editor, your browser's address bar is safely and silently updated with your exact WGS84 GPS coordinates. 

If you accidentally close the tab or press the refresh button (F5), the script ensures that WME loads natively exactly where you left off. It also automatically strips out volatile object IDs (like selected segments or update requests) during movement, preventing WME from crashing with "404 Not Found" errors upon reload.

*Note: There are no extra menus or buttons to click. The script strictly adheres to the modern WME SDK and uses debouncing to keep your editing experience clean, fast, and crash-free.*

## Installation instructions

> TL;DR: Install via your preferred userscript manager from its Greasy Fork page: [Insert Greasy Fork Link Here]

Userscripts are snippets of code that are executed after the loading of certain webpages. In order to run userscripts in your browser, you are advised to use Firefox or Google Chrome.

You will need to install an add-on that manages userscripts for this to work. A popular and reliable choice is Tampermonkey for [Firefox](https://addons.mozilla.org/en-US/firefox/addon/tampermonkey/) and [Chrome](https://chrome.google.com/webstore/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo).

After installing Tampermonkey, simply navigate to the Greasy Fork link above and click the green install button. If you already have the Waze Map Editor open, please refresh the page for the script to take effect. 

*This script is designed to run exclusively on Waze.com and will not affect your browsing on other websites.*

## Feedback and suggestions

This "Candy Remix" was built to restore functionality following Waze's transition to a new mapping engine and the deprecation of OpenLayers. All foundational credit belongs to the original author, dBsooner, whose original script saved countless editors so much time over the years. 

If you encounter any bugs, have suggestions for improvement, or if WME goes through another major architectural update, please feel free to leave a comment on the Greasy Fork feedback page or submit a pull request. Contributions and forks to keep this tool alive are always welcome!
