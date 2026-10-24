// Options: API key and language in chrome.storage.local, and a one-time mic grant.
const $ = (id) => document.getElementById(id);

function status(id, text, ok) {
	const el = $(id);
	el.textContent = text;
	el.className = `status ${ok === true ? "ok" : ok === false ? "bad" : ""}`;
}

async function load() {
	const { reson8ApiKey, reson8Language } = await chrome.storage.local.get([
		"reson8ApiKey",
		"reson8Language",
	]);
	$("key").value = reson8ApiKey || "";
	$("lang").value = reson8Language || "en";
	status(
		"key-status",
		reson8ApiKey
			? "A key is saved."
			: "No key saved. Add a Reson8 key to use voice.",
	);
}

$("save").addEventListener("click", async () => {
	const key = $("key").value.trim();
	await chrome.storage.local.set({
		reson8ApiKey: key,
		reson8Language: $("lang").value,
	});
	status("key-status", key ? "Saved." : "Saved without a key.", true);
});

$("test").addEventListener("click", async () => {
	status("key-status", "Testing...");
	const res = await chrome.runtime.sendMessage({
		type: "dnt:token",
		force: true,
	});
	if (res?.token)
		status("key-status", "The key works: Reson8 issued an access token.", true);
	else if (res?.error === "missing_key")
		status("key-status", "Save a key first.", false);
	else if (res?.error === "invalid_key")
		status("key-status", "Reson8 rejected this key (401).", false);
	else if (res?.error === "network")
		status("key-status", "Could not reach api.reson8.dev.", false);
	else
		status(
			"key-status",
			`Token request failed (${res?.error || "unknown"}).`,
			false,
		);
});

$("show").addEventListener("click", (e) => {
	const showing = $("key").type === "text";
	$("key").type = showing ? "password" : "text";
	e.target.textContent = showing ? "Show" : "Hide";
	e.target.setAttribute("aria-pressed", String(!showing));
});

$("clear").addEventListener("click", async () => {
	await chrome.storage.local.remove("reson8ApiKey");
	$("key").value = "";
	status("key-status", "Key removed.", true);
});

$("grant-mic").addEventListener("click", async () => {
	try {
		const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
		stream.getTracks().forEach((t) => t.stop());
		status(
			"mic-status",
			"Microphone access granted. Go back to the side panel and press Start voice.",
			true,
		);
	} catch (err) {
		status(
			"mic-status",
			`Microphone not available: ${err.name === "NotAllowedError" ? "permission was denied. Allow it from the icon in the address bar." : err.message}`,
			false,
		);
	}
});

if (location.hash === "#mic") $("grant-mic").focus();
load();
