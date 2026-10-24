// Service worker: opens the panel, injects the overlay, captures the visible tab,
// exchanges the stored API key for a short-lived Reson8 token, and relays shortcuts.
const TOKEN_URL = "https://api.reson8.dev/v1/auth/token";

// The toolbar click grants activeTab for this tab. sidePanel.open must run before any
// await so it stays inside the user gesture.
chrome.action.onClicked.addListener((tab) => {
	chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
	injectOverlay(tab.id);
});

chrome.commands.onCommand.addListener((command, tab) => {
	if (command === "toggle-draw" && tab) {
		chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
		injectOverlay(tab.id).then((error) => relay(command, tab.id, error));
		return;
	}
	relay(command, tab?.id);
});

function relay(command, tabId, error) {
	chrome.runtime
		.sendMessage({ type: "dnt:command", command, tabId, error })
		.catch(() => {});
}

// Resolves to an error message, or null on success. The error is also stored so a
// panel that is still opening can explain it (e.g. "Cannot access a chrome:// URL").
async function injectOverlay(tabId) {
	let error = null;
	try {
		await chrome.scripting.executeScript({
			target: { tabId },
			files: ["content/loader.js"],
		});
	} catch (err) {
		error = String(err?.message || err);
	}
	await chrome.storage.session
		.set({ [`injectError:${tabId}`]: error })
		.catch(() => {});
	chrome.runtime
		.sendMessage({ type: "dnt:injectResult", tabId, error })
		.catch(() => {});
	return error;
}

// ---------- token ----------
let cached = null; // { token, expiresAt }

async function getToken({ force = false } = {}) {
	if (!force && cached && cached.expiresAt - Date.now() > 30_000) return cached;
	const { reson8ApiKey } = await chrome.storage.local.get("reson8ApiKey");
	if (!reson8ApiKey) return { error: "missing_key" };
	let res;
	try {
		res = await fetch(TOKEN_URL, {
			method: "POST",
			headers: { Authorization: `ApiKey ${reson8ApiKey}` },
		});
	} catch {
		return { error: "network" };
	}
	if (res.status === 401) return { error: "invalid_key" };
	if (!res.ok) return { error: `http_${res.status}` };
	const body = await res.json();
	cached = {
		token: body.access_token,
		expiresAt: Date.now() + (body.expires_in ?? 600) * 1000,
	};
	return cached;
}

chrome.storage.onChanged.addListener((changes) => {
	if (changes.reson8ApiKey) cached = null;
});

// ---------- messages from the panel and options page ----------
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
	// Only extension pages (panel, options) may ask for tokens or captures. Content
	// scripts report the page URL as sender.url, so this rejects them.
	if (!sender.url?.startsWith(chrome.runtime.getURL(""))) return false;
	if (msg?.type === "dnt:token") {
		getToken({ force: msg.force }).then(reply);
		return true;
	}
	if (msg?.type === "dnt:capture") {
		chrome.tabs.captureVisibleTab(msg.windowId, { format: "png" }).then(
			(dataUrl) => reply({ ok: true, dataUrl }),
			(err) => reply({ ok: false, error: String(err?.message || err) }),
		);
		return true;
	}
	return false;
});
