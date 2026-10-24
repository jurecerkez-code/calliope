// Injected with chrome.scripting.executeScript. Content scripts cannot be ES modules,
// so this classic script imports the overlay module. The browser caches the module,
// so injecting twice does not create a second overlay.
(() => {
	import(chrome.runtime.getURL("content/overlay.js")).catch((err) => {
		console.error("[draw-and-talk] overlay failed to load", err);
	});
})();
