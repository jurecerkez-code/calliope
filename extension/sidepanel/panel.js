// Side panel: owns the session clock, the microphone and Reson8 socket, the timeline,
// fusion results, and export. The page overlay only draws and reports strokes.

import { copyPng, copyText, downloadBlob, renderPng } from "../lib/export.js";
import {
	buildPacket,
	DEICTICS,
	fuse,
	MS_PER_WORD,
	packetText,
	simulateWords,
} from "../lib/fusion.js";
import { adaptMessage, Reson8Client, SAMPLE_RATE } from "../lib/reson8.js";
import { strokeColor } from "../lib/strokes.js";

const $ = (id) => document.getElementById(id);

// ---------- session ----------
function freshSession(tabId = null, windowId = null) {
	return {
		startEpoch: Date.now(),
		tabId,
		windowId,
		page: null,
		base: "live-dom",
		baseChanges: [{ atMs: 0, base: "live-dom" }],
		screenshot: null,
		strokes: [],
		utterances: [],
		interim: null,
		nextUtt: 1,
		drawing: false,
	};
}

let session = freshSession();
const now = () => Date.now() - session.startEpoch;

// ---------- banners ----------
const banners = new Map();
function showBanner(key, kind, text, actions = []) {
	banners.set(key, { kind, text, actions });
	renderBanners();
}
function clearBanner(key) {
	if (banners.delete(key)) renderBanners();
}
function renderBanners() {
	const box = $("banners");
	box.replaceChildren(
		...[...banners.values()].map(({ kind, text, actions }) =>
			h(
				"div",
				{ class: `banner ${kind}` },
				h("p", {}, text),
				actions.length
					? h(
							"div",
							{ class: "actions" },
							...actions.map((a) =>
								h(
									"button",
									{ class: "btn", type: "button", onclick: a.run },
									a.label,
								),
							),
						)
					: null,
			),
		),
	);
}

let toastTimer = 0;
function toast(text, kind = "info") {
	showBanner("toast", kind, text);
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => clearBanner("toast"), 3500);
}

// ---------- tiny DOM helpers ----------
function h(tag, attrs = {}, ...children) {
	const el = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (v == null || v === false) continue;
		if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
		else if (k === "class") el.className = v;
		else if (k === "style") el.style.cssText = v;
		else el.setAttribute(k, v === true ? "" : v);
	}
	for (const c of children.flat()) if (c != null && c !== false) el.append(c);
	return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";
function s(tag, attrs = {}, ...children) {
	const el = document.createElementNS(SVG_NS, tag);
	for (const [k, v] of Object.entries(attrs))
		if (v != null) el.setAttribute(k, v);
	for (const c of children.flat()) if (c != null) el.append(c);
	return el;
}

const fmtS = (ms) => `${(ms / 1000).toFixed(1)}s`;

// ---------- tab attachment ----------
const RESTRICTED =
	/chrome:\/\/|chrome-extension:\/\/|extensions gallery|chromewebstore|devtools:|edge:\/\/|about:|view-source:|chrome-search:|cannot be scripted/i;
const NEEDS_FILE_ACCESS = /file:\/\//i;

function send(tabId, msg) {
	return chrome.tabs.sendMessage(tabId, msg);
}

async function ping(tabId) {
	try {
		const r = await send(tabId, { type: "dnt:ping" });
		return !!r?.ok;
	} catch {
		return false;
	}
}

// Injects the overlay if needed. Returns true when the overlay answers.
async function ensureOverlay(tabId) {
	if (await ping(tabId)) return true;
	try {
		await chrome.scripting.executeScript({
			target: { tabId },
			files: ["content/loader.js"],
		});
	} catch (err) {
		// Without access to the tab, Chrome hides its URL and reports a generic error.
		// A toolbar click grants access, so its error (stored by background.js) is
		// more specific, e.g. "Cannot access a chrome:// URL".
		const key = `injectError:${tabId}`;
		const stored = (await chrome.storage.session.get(key).catch(() => ({})))[key];
		explainInjectError(stored || String(err?.message || err));
		return false;
	}
	for (let i = 0; i < 20; i++) {
		if (await ping(tabId)) return true;
		await new Promise((r) => setTimeout(r, 100));
	}
	showBanner(
		"tab",
		"error",
		"The drawing overlay did not start on this page. Reload the page and try again.",
	);
	return false;
}

function explainInjectError(message) {
	if (RESTRICTED.test(message)) {
		showBanner(
			"tab",
			"warn",
			"Chrome does not let extensions draw on this page (browser pages, the Chrome Web Store, and some PDF viewers are restricted). Switch to a normal web page.",
		);
	} else if (NEEDS_FILE_ACCESS.test(message)) {
		showBanner(
			"tab",
			"warn",
			'To draw on local files, enable "Allow access to file URLs" for Draw and Talk on chrome://extensions, or serve the file over http://localhost.',
		);
	} else {
		showBanner(
			"tab",
			"warn",
			"Draw and Talk cannot reach this tab yet. On a normal web page, click the Draw and Talk toolbar button (or press Alt+Shift+D). Browser pages such as chrome:// and the Chrome Web Store cannot be drawn on.",
			[{ label: "Allow on all sites", run: requestAllSites }],
		);
	}
}

async function requestAllSites() {
	const granted = await chrome.permissions.request({
		origins: ["http://*/*", "https://*/*"],
	});
	if (granted) {
		clearBanner("tab");
		attachToActiveTab();
	}
}

async function activeTab() {
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	return tab;
}

async function initOverlay() {
	const r = await send(session.tabId, {
		type: "dnt:init",
		startEpoch: session.startEpoch,
		strokes: session.strokes,
		nextId: nextStrokeId(),
		base: session.base,
		screenshot: session.screenshot,
		drawing: session.drawing,
	});
	if (r?.ok) session.page = { url: r.url, title: r.title };
	return r?.ok;
}

function nextStrokeId() {
	const max = session.strokes.reduce(
		(m, st) => Math.max(m, parseInt(st.id.slice(1), 10) || 0),
		0,
	);
	return max + 1;
}

async function attachTo(tabId, windowId) {
	// Inject first, so a failed attach (restricted page) never discards the session.
	if (!(await ensureOverlay(tabId))) return false;
	if (session.tabId !== tabId) {
		// A session belongs to one page. Keep work only if nothing has been captured yet.
		if (session.strokes.length || session.utterances.length) {
			session = freshSession(tabId, windowId);
		} else {
			session.tabId = tabId;
			session.windowId = windowId;
		}
	}
	clearBanner("tab");
	clearBanner("other-tab");
	await initOverlay();
	render();
	return true;
}

async function attachToActiveTab() {
	const tab = await activeTab();
	if (tab) await attachTo(tab.id, tab.windowId);
}

chrome.tabs.onActivated.addListener(({ tabId }) => {
	if (session.tabId == null || tabId === session.tabId) {
		clearBanner("other-tab");
		if (session.tabId == null) attachToActiveTab();
		return;
	}
	showBanner("other-tab", "info", "This session is drawing on another tab.", [
		{
			label: "Go back",
			run: () => chrome.tabs.update(session.tabId, { active: true }),
		},
		{ label: "New session here", run: () => attachToActiveTab() },
	]);
});

chrome.tabs.onRemoved.addListener((tabId) => {
	if (tabId === session.tabId) {
		showBanner(
			"tab",
			"warn",
			"The tab for this session was closed. You can still copy the packet.",
		);
		session.tabId = null;
	}
});

// ---------- messages from the overlay and background ----------
chrome.runtime.onMessage.addListener((msg, sender) => {
	const fromSessionTab = sender.tab && sender.tab.id === session.tabId;
	switch (msg?.type) {
		case "dnt:ready":
			// Overlay (re)loaded, e.g. after a reload: restore our strokes into it.
			if (fromSessionTab) initOverlay();
			else if (sender.tab && session.tabId == null)
				attachTo(sender.tab.id, sender.tab.windowId);
			break;
		case "dnt:stroke":
			if (!fromSessionTab) break;
			session.strokes = session.strokes
				.filter((st) => st.id !== msg.stroke.id)
				.concat(msg.stroke);
			render();
			break;
		case "dnt:undo":
			if (!fromSessionTab) break;
			session.strokes = session.strokes.filter((st) => st.id !== msg.id);
			render();
			break;
		case "dnt:drawState":
			if (!fromSessionTab) break;
			session.drawing = msg.drawing;
			renderControls();
			break;
		case "dnt:command":
			onCommand(msg);
			break;
		case "dnt:injectResult":
			onInjectResult(msg);
			break;
	}
	return false;
});

// The toolbar button injected (or failed to inject) into a tab.
async function onInjectResult({ tabId, error }) {
	const tab = await activeTab();
	if (tab?.id !== tabId) return;
	if (error) explainInjectError(error);
	else if (session.tabId == null || session.tabId === tabId) attachTo(tabId, tab.windowId);
}

async function onCommand({ command, tabId, error }) {
	if (command === "toggle-draw") {
		if (error) return explainInjectError(error);
		if (tabId !== session.tabId) {
			const tab = await chrome.tabs.get(tabId);
			if (!(await attachTo(tabId, tab.windowId))) return;
		}
		toggleDraw();
	} else if (command === "toggle-voice") {
		toggleVoice();
	} else if (command === "copy-packet") {
		copyPacket();
	}
}

// ---------- drawing controls ----------
async function toggleDraw(on = !session.drawing) {
	if (session.tabId == null) await attachToActiveTab();
	if (session.tabId == null) return;
	if (!(await ensureOverlay(session.tabId))) return;
	const r = await send(session.tabId, { type: "dnt:setDraw", on });
	session.drawing = !!r?.drawing;
	renderControls();
}

async function setBase(base) {
	if (base === session.base) return;
	if (base === "screenshot") {
		const shot = await captureClean();
		if (!shot) {
			document.querySelector('input[name="base"][value="live-dom"]').checked =
				true;
			return;
		}
		session.screenshot = shot;
	}
	session.base = base;
	session.baseChanges.push({ atMs: now(), base });
	await send(session.tabId, {
		type: "dnt:setBase",
		base,
		screenshot: base === "screenshot" ? session.screenshot : null,
	});
	renderControls();
}

// Hides the overlay, captures the visible tab, and restores the overlay.
async function captureClean() {
	if (session.tabId == null) {
		toast("Attach to a page first.", "warn");
		return null;
	}
	const tab = await chrome.tabs.get(session.tabId);
	if (!tab.active) {
		toast("Switch to the session tab to capture it.", "warn");
		return null;
	}
	let vp;
	try {
		vp = await send(session.tabId, { type: "dnt:hide" });
		// Give the compositor a frame to drop the overlay.
		await new Promise((r) => setTimeout(r, 60));
		const res = await chrome.runtime.sendMessage({
			type: "dnt:capture",
			windowId: tab.windowId,
		});
		if (!res?.ok) throw new Error(res?.error || "capture failed");
		return {
			dataUrl: res.dataUrl,
			scrollX: vp.scrollX,
			scrollY: vp.scrollY,
			width: vp.width,
			height: vp.height,
		};
	} catch (err) {
		toast(
			`Could not capture the tab: ${err.message}. Click the toolbar button on the page and try again.`,
			"error",
		);
		return null;
	} finally {
		send(session.tabId, { type: "dnt:show" }).catch(() => {});
	}
}

// ---------- live voice ----------
const voice = {
	client: null,
	stream: null,
	ctx: null,
	node: null,
	audioStartMs: null,
	active: false,
	starting: false,
};

async function toggleVoice() {
	if (voice.active || voice.starting) stopVoice();
	else startVoice();
}

async function startVoice() {
	voice.starting = true;
	setVoiceState("Connecting...");
	clearBanner("voice");
	try {
		if (!navigator.onLine)
			throw new VoiceError("You are offline. Typed speech still works.");
		const tok = await chrome.runtime.sendMessage({ type: "dnt:token" });
		if (tok?.error === "missing_key") {
			throw new VoiceError(
				"Add your Reson8 API key to use live voice. Typed speech works without it.",
				[
					{
						label: "Open options",
						run: () => chrome.runtime.openOptionsPage(),
					},
				],
			);
		}
		if (tok?.error === "invalid_key") {
			throw new VoiceError(
				"Reson8 rejected the API key (401). Check it in Options.",
				[
					{
						label: "Open options",
						run: () => chrome.runtime.openOptionsPage(),
					},
				],
			);
		}
		if (tok?.error === "network")
			throw new VoiceError(
				"Could not reach Reson8 to get a token. Check your network.",
			);
		if (!tok?.token)
			throw new VoiceError(
				`Could not get a Reson8 token (${tok?.error || "unknown error"}).`,
			);

		try {
			voice.stream = await navigator.mediaDevices.getUserMedia({
				audio: {
					channelCount: 1,
					echoCancellation: true,
					noiseSuppression: true,
				},
			});
		} catch (err) {
			if (err.name === "NotAllowedError" || err.name === "SecurityError") {
				// Side panels cannot show the permission prompt; an extension tab can.
				throw new VoiceError(
					"Microphone access is needed. Grant it once in the options tab, then press Start voice again.",
					[
						{
							label: "Grant microphone",
							run: () =>
								chrome.tabs.create({
									url: chrome.runtime.getURL("options/options.html#mic"),
								}),
						},
					],
				);
			}
			if (err.name === "NotFoundError")
				throw new VoiceError("No microphone was found.");
			throw new VoiceError(`Microphone error: ${err.message}`);
		}

		const { reson8Language } = await chrome.storage.local.get("reson8Language");
		voice.client = new Reson8Client({
			onTranscript: onTranscript,
			onError: (text) => {
				showBanner("voice", "error", text);
				stopVoice();
			},
		});
		await voice.client.connect(tok.token, { language: reson8Language || "en" });

		voice.ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
		await voice.ctx.audioWorklet.addModule("pcm-worklet.js");
		const src = voice.ctx.createMediaStreamSource(voice.stream);
		voice.node = new AudioWorkletNode(voice.ctx, "pcm-capture");
		voice.audioStartMs = null;
		voice.node.port.onmessage = (ev) => {
			if (voice.audioStartMs == null) {
				// Reson8 word times are relative to the audio stream. The first frame holds
				// ~100 ms of audio captured before it was sent, so its start is send time - 100 ms.
				voice.audioStartMs =
					now() - (ev.data.byteLength / 2 / SAMPLE_RATE) * 1000;
			}
			voice.client?.sendAudio(ev.data);
		};
		src.connect(voice.node);
		voice.active = true;
		setVoiceState("Listening");
	} catch (err) {
		teardownAudio();
		voice.client?.close({ graceMs: 0 });
		voice.client = null;
		if (err instanceof VoiceError)
			showBanner("voice", "error", err.message, err.actions);
		else showBanner("voice", "error", `Live voice failed: ${err.message}`);
		setVoiceState("Reson8 live speech");
	} finally {
		voice.starting = false;
		renderControls();
	}
}

class VoiceError extends Error {
	constructor(message, actions = []) {
		super(message);
		this.actions = actions;
	}
}

function teardownAudio() {
	voice.node?.disconnect();
	voice.stream?.getTracks().forEach((t) => t.stop());
	voice.ctx?.close().catch(() => {});
	voice.node = voice.stream = voice.ctx = null;
}

function stopVoice() {
	teardownAudio();
	voice.client?.close();
	voice.client = null;
	voice.active = false;
	setVoiceState("Reson8 live speech");
	renderControls();
}

function onTranscript(raw) {
	const t = adaptMessage(raw, voice.audioStartMs ?? now());
	if (!t) return;
	if (!t.final) {
		session.interim = t;
	} else {
		session.interim = null;
		if (t.text) addUtterance({ ...t, source: "reson8" });
	}
	render();
}

function setVoiceState(text) {
	$("voice-state").textContent = text;
}

// ---------- simulated speech ----------
let typingStartMs = null;
$("say-text").addEventListener("input", (e) => {
	if (e.target.value.trim() && typingStartMs == null) typingStartMs = now();
	if (!e.target.value.trim()) typingStartMs = null;
});
$("say-text").addEventListener("keydown", (e) => {
	if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
		e.preventDefault();
		say();
	}
});

function say() {
	const text = $("say-text").value.trim();
	if (!text) return;
	const endMs = now();
	// The typed words count as spoken over the time spent typing, ending now. Without a
	// typing interval (pasted text), assume a normal speaking rate.
	const words = text.split(/\s+/).length;
	const startMs =
		typingStartMs != null && typingStartMs < endMs
			? typingStartMs
			: Math.max(0, endMs - words * MS_PER_WORD);
	addUtterance({
		text,
		final: true,
		startMs,
		endMs,
		words: simulateWords(text, startMs, endMs),
		source: "simulated",
	});
	$("say-text").value = "";
	typingStartMs = null;
	render();
}

function addUtterance(u) {
	session.utterances.push({ id: `U${session.nextUtt++}`, ...u });
}

// ---------- export ----------
function currentPacket() {
	return buildPacket({
		elapsedMs: now(),
		base: session.base,
		baseChanges: session.baseChanges,
		page: session.page,
		strokes: session.strokes,
		utterances: session.utterances,
	});
}

async function copyPacket() {
	const text = packetText(currentPacket());
	$("manual-copy").hidden = true;
	try {
		await copyText(text);
	} catch {
		// The shortcut fires while the page has focus, so the panel cannot write the
		// clipboard; the page can.
		let ok = false;
		if (session.tabId != null) {
			ok = (
				await send(session.tabId, { type: "dnt:writeClipboard", text }).catch(
					() => null,
				)
			)?.ok;
		}
		if (!ok) {
			$("manual-copy").value = text;
			$("manual-copy").hidden = false;
			$("manual-copy").select();
			toast(
				"The browser blocked clipboard access. Select the text below and copy it.",
				"warn",
			);
			return;
		}
	}
	toast(
		`Copied packet: ${session.strokes.length} stroke(s), ${session.utterances.length} utterance(s). Paste the PNG alongside it.`,
	);
}

async function snapshot() {
	const shot =
		session.base === "screenshot" && session.screenshot
			? session.screenshot
			: await captureClean();
	if (!shot) return null;
	const result = await renderPng(shot, session.strokes);
	if (result.clipped.length) {
		toast(
			`${result.clipped.join(", ")} ${result.clipped.length > 1 ? "are" : "is"} outside the captured area and may be cut off.`,
			"warn",
		);
	}
	return result.blob;
}

const pngName = () =>
	`draw-and-talk-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;

async function copySnapshot() {
	const blob = await snapshot();
	if (!blob) return;
	try {
		await copyPng(blob);
		toast("Copied PNG to the clipboard.");
	} catch {
		downloadBlob(blob, pngName());
		toast(
			"This browser would not copy the image, so it was downloaded instead.",
			"warn",
		);
	}
}

async function downloadSnapshot() {
	const blob = await snapshot();
	if (blob) downloadBlob(blob, pngName());
}

async function resetSession() {
	if (voice.active) stopVoice();
	const { tabId, windowId } = session;
	session = freshSession(tabId, windowId);
	document.querySelector('input[name="base"][value="live-dom"]').checked = true;
	$("manual-copy").hidden = true;
	if (tabId != null) {
		await send(tabId, { type: "dnt:clear" }).catch(() => {});
		await send(tabId, { type: "dnt:setBase", base: "live-dom" }).catch(
			() => {},
		);
		await initOverlay().catch(() => {});
	}
	render();
}

// ---------- rendering ----------
function render() {
	renderControls();
	const finals = session.utterances.filter((u) => u.final);
	const fused = fuse(finals, session.strokes);
	renderUtterances(fused);
	renderStrokes();
	renderTimeline(fused);
	persist();
}

function renderControls() {
	const draw = $("btn-draw");
	draw.setAttribute("aria-pressed", String(session.drawing));
	draw.textContent = session.drawing ? "Stop drawing" : "Start drawing";
	const v = $("btn-voice");
	v.setAttribute("aria-pressed", String(voice.active));
	v.textContent = voice.active
		? "Stop voice"
		: voice.starting
			? "Connecting..."
			: "Start voice";
	v.disabled = voice.starting;
	$("btn-undo").disabled = !session.strokes.length;
	for (const radio of document.querySelectorAll('input[name="base"]')) {
		radio.checked = radio.value === session.base;
	}
	$("base-hint").textContent =
		session.base === "screenshot"
			? "Screenshot base: a still image of the visible area only. Strokes are still matched to the live page underneath."
			: "Strokes are matched to elements on the live page.";
	const interim = $("interim");
	interim.hidden = !session.interim;
	interim.textContent = session.interim ? `"${session.interim.text}"` : "";
}

function targetLine(t) {
	if (!t || !t.selector) return h("span", { class: "muted" }, "no element");
	return h(
		"span",
		{},
		`${t.tag} "${t.label}" `,
		h("code", {}, t.selector),
		` ${Math.round(t.confidence * 100)}%`,
	);
}

function renderUtterances(fused) {
	const list = $("utterances");
	list.dataset.empty = "No speech yet. Start voice or type and press Say.";
	list.replaceChildren(
		...fused
			.slice()
			.reverse()
			.map((u) =>
				h(
					"li",
					{ class: "item" },
					h(
						"div",
						{ class: "head" },
						h("span", { class: "chip" }, u.id),
						h("span", { class: "chip intent" }, u.intent),
						h("span", { class: "chip" }, u.source),
						h(
							"span",
							{ class: "muted" },
							`${fmtS(u.startMs)}–${fmtS(u.endMs)}`,
						),
					),
					h("div", { class: "text" }, u.text),
					h("div", { class: "sub" }, "Target: ", targetLine(u.target)),
					u.references.length
						? h(
								"div",
								{ class: "sub" },
								"Refs: ",
								u.references
									.map(
										(r) =>
											`${r.word ? `"${r.word}"` : "(implicit)"} @${fmtS(r.atMs)} → ${r.strokeId || "none in window"}${r.strokeId ? ` (${Math.round(r.confidence * 100)}%)` : ""}`,
									)
									.join(", "),
							)
						: h(
								"div",
								{ class: "sub" },
								"Refs: none (no stroke near this utterance)",
							),
				),
			),
	);
}

function renderStrokes() {
	const list = $("strokes");
	list.dataset.empty =
		"No strokes yet. Start drawing and mark something on the page.";
	list.replaceChildren(
		...session.strokes
			.slice()
			.reverse()
			.map((st) =>
				h(
					"li",
					{
						class: "item",
						onmouseenter: () =>
							session.tabId != null &&
							send(session.tabId, { type: "dnt:highlight", id: st.id }).catch(
								() => {},
							),
						onmouseleave: () =>
							session.tabId != null &&
							send(session.tabId, { type: "dnt:highlight", id: null }).catch(
								() => {},
							),
					},
					h(
						"div",
						{ class: "head" },
						h("span", {
							class: "swatch",
							style: `background:${strokeColor(st.id)}`,
						}),
						h("span", { class: "text" }, st.id),
						h("span", { class: "chip" }, st.shape),
						h(
							"span",
							{ class: "muted" },
							`${fmtS(st.startMs)}–${fmtS(st.endMs)}`,
						),
					),
					st.targets.length
						? h(
								"ol",
								{ class: "targets" },
								st.targets.map((t) => h("li", {}, targetLine(t))),
							)
						: h(
								"div",
								{ class: "sub" },
								"No element under this stroke (outside the viewport?)",
							),
				),
			),
	);
}

// Lanes: drawing, speech (with word ticks), references (linked to their strokes).
function renderTimeline(fused) {
	const box = $("timeline");
	const W = Math.max(240, box.clientWidth || 300);
	const left = 58,
		right = 8,
		laneH = 26,
		gapY = 6,
		top = 4;
	const lanes = ["Drawing", "Speech", "Refs"];
	const H = top + lanes.length * (laneH + gapY) + 14;
	const span = Math.max(10_000, now() + 1000);
	const x = (ms) => left + (Math.max(0, ms) / span) * (W - left - right);
	const laneY = (i) => top + i * (laneH + gapY);

	const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H });
	lanes.forEach((name, i) => {
		svg.append(
			s("rect", {
				class: "lane",
				x: left,
				y: laneY(i),
				width: W - left - right,
				height: laneH,
				rx: 4,
			}),
			s(
				"text",
				{ class: "lane-label", x: 0, y: laneY(i) + laneH / 2 + 3 },
				name,
			),
		);
	});
	const step = span > 60_000 ? 10_000 : span > 20_000 ? 5_000 : 2_000;
	for (let t = 0; t <= span; t += step) {
		svg.append(
			s("line", {
				class: "tick",
				x1: x(t),
				x2: x(t),
				y1: top,
				y2: laneY(2) + laneH,
			}),
			s(
				"text",
				{ class: "tick-label", x: x(t), y: H - 2, "text-anchor": "middle" },
				`${t / 1000}s`,
			),
		);
	}

	const strokeMid = {};
	for (const st of session.strokes) {
		const x1 = x(st.startMs),
			x2 = Math.max(x(st.endMs), x1 + 14);
		strokeMid[st.id] = (x1 + x2) / 2;
		svg.append(
			s(
				"rect",
				{
					x: x1,
					y: laneY(0) + 3,
					width: x2 - x1,
					height: laneH - 6,
					rx: 3,
					fill: strokeColor(st.id),
				},
				s(
					"title",
					{},
					`${st.id} ${st.shape} ${fmtS(st.startMs)}–${fmtS(st.endMs)}`,
				),
			),
			s(
				"text",
				{ class: "stroke-id", x: x1 + 3, y: laneY(0) + laneH / 2 + 3 },
				st.id,
			),
		);
	}

	const speechItems = [
		...fused,
		...(session.interim ? [{ ...session.interim, interim: true }] : []),
	];
	for (const u of speechItems) {
		const x1 = x(u.startMs),
			x2 = Math.max(x(u.endMs), x1 + 4);
		svg.append(
			s(
				"rect",
				{
					class: `utt${u.interim ? " interim" : ""}`,
					x: x1,
					y: laneY(1) + 3,
					width: x2 - x1,
					height: laneH - 6,
					rx: 3,
				},
				s("title", {}, `${u.id || "interim"}: ${u.text}`),
			),
		);
		for (const w of u.words || []) {
			const deictic = DEICTICS.has(w.text.toLowerCase().replace(/[^a-z]/g, ""));
			svg.append(
				s(
					"line",
					{
						class: `word${deictic ? " deictic" : ""}`,
						x1: x(w.startMs),
						x2: x(w.startMs),
						y1: laneY(1) + 6,
						y2: laneY(1) + laneH - 6,
					},
					s("title", {}, `${w.text} @${fmtS(w.startMs)}`),
				),
			);
		}
	}

	for (const u of fused) {
		for (const r of u.references) {
			const rx = x(r.atMs),
				ry = laneY(2) + laneH / 2;
			if (r.strokeId && strokeMid[r.strokeId] != null) {
				svg.append(
					s("line", {
						class: "ref-link",
						x1: rx,
						y1: ry,
						x2: strokeMid[r.strokeId],
						y2: laneY(0) + laneH - 3,
					}),
				);
			}
			svg.append(
				s(
					"circle",
					{
						class: `ref-dot${r.strokeId ? "" : " unbound"}`,
						cx: rx,
						cy: ry,
						r: 5,
						fill: r.strokeId ? strokeColor(r.strokeId) : null,
					},
					s(
						"title",
						{},
						`${r.word ? `"${r.word}"` : "(implicit)"} → ${r.strokeId || "unbound"}`,
					),
				),
			);
		}
	}

	svg.append(
		s("line", {
			class: "now",
			x1: x(now()),
			x2: x(now()),
			y1: top,
			y2: laneY(2) + laneH,
		}),
	);
	box.replaceChildren(svg);
}

// Keep the panel's session across panel reloads (not across browser restarts).
let persistTimer = 0;
function persist() {
	clearTimeout(persistTimer);
	persistTimer = setTimeout(() => {
		const { screenshot, interim, ...rest } = session;
		chrome.storage.session.set({ dntSession: rest }).catch(() => {});
	}, 300);
}

async function restore() {
	const { dntSession } = await chrome.storage.session
		.get("dntSession")
		.catch(() => ({}));
	if (dntSession) {
		session = {
			...freshSession(),
			...dntSession,
			screenshot: null,
			interim: null,
			drawing: false,
		};
		// A screenshot does not survive a reload, so fall back to the live page.
		if (session.base === "screenshot") {
			session.base = "live-dom";
			session.baseChanges.push({ atMs: now(), base: "live-dom" });
		}
	}
}

// ---------- wiring ----------
$("btn-draw").addEventListener("click", () => toggleDraw());
$("btn-undo").addEventListener(
	"click",
	() =>
		session.tabId != null &&
		send(session.tabId, { type: "dnt:undo" }).catch(() => {}),
);
$("btn-voice").addEventListener("click", toggleVoice);
$("btn-say").addEventListener("click", say);
$("btn-copy").addEventListener("click", copyPacket);
$("btn-copy-png").addEventListener("click", copySnapshot);
$("btn-download-png").addEventListener("click", downloadSnapshot);
$("btn-reset").addEventListener("click", resetSession);
$("lnk-options").addEventListener("click", (e) => {
	e.preventDefault();
	chrome.runtime.openOptionsPage();
});
for (const radio of document.querySelectorAll('input[name="base"]')) {
	radio.addEventListener("change", (e) => setBase(e.target.value));
}
addEventListener("offline", () =>
	showBanner(
		"net",
		"warn",
		"You are offline. Live voice will not work; typed speech still does.",
	),
);
addEventListener("online", () => clearBanner("net"));
addEventListener("resize", () => render());

async function checkKey() {
	const { reson8ApiKey } = await chrome.storage.local.get("reson8ApiKey");
	if (!reson8ApiKey) {
		showBanner(
			"key",
			"info",
			"No Reson8 API key yet. Live voice needs one; typed speech works without it.",
			[{ label: "Add key", run: () => chrome.runtime.openOptionsPage() }],
		);
	} else {
		clearBanner("key");
	}
}
chrome.storage.onChanged.addListener((changes, area) => {
	if (area === "local" && changes.reson8ApiKey) checkKey();
});

setInterval(() => {
	$("clock").textContent = fmtS(now());
	renderTimeline(
		fuse(
			session.utterances.filter((u) => u.final),
			session.strokes,
		),
	);
}, 500);

(async () => {
	await restore();
	checkKey();
	if (!navigator.onLine)
		showBanner(
			"net",
			"warn",
			"You are offline. Live voice will not work; typed speech still does.",
		);
	const tab = await activeTab();
	if (tab)
		await attachTo(session.tabId ?? tab.id, session.windowId ?? tab.windowId);
	render();
})();

// Exposed for the automated test harness and for debugging in DevTools.
globalThis.dnt = {
	get session() {
		return session;
	},
	currentPacket,
	say,
	attachTo,
	toggleDraw,
	setBase,
	snapshot,
	copyPacket,
};
