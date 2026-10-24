// Canvas overlay: freehand capture in page coordinates, redraw on scroll, DOM targets
// on stroke end. The side panel owns the session; this script only draws and reports.
import { makeStroke, paintStroke } from "../lib/strokes.js";
import { resolveTargets } from "../lib/targets.js";

const state = {
	startEpoch: Date.now(),
	drawing: false,
	base: "live-dom",
	screenshot: null, // { dataUrl, scrollX, scrollY, width, height }
	strokes: [],
	current: null,
	nextId: 1,
	highlightId: null,
};

const now = () => Date.now() - state.startEpoch;

// ---------- DOM ----------
function el(tag, props = {}) {
	return Object.assign(document.createElement(tag), props);
}

const host = el("draw-and-talk-overlay");
host.style.cssText =
	"all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;";
const root = host.attachShadow({ mode: "closed" });
const baseImg = el("img", { className: "base", alt: "", hidden: true });
const canvas = el("canvas", { className: "ink" });
const pill = el("button", { className: "pill", type: "button" });
pill.setAttribute("aria-live", "polite");
root.append(
	el("link", {
		rel: "stylesheet",
		href: chrome.runtime.getURL("content/overlay.css"),
	}),
	baseImg,
	canvas,
	pill,
);
const ctx = canvas.getContext("2d");
document.documentElement.appendChild(host);

function updatePill() {
	pill.textContent = state.drawing
		? "Drawing · Esc to stop"
		: "Draw and Talk · click to draw";
	pill.dataset.drawing = String(state.drawing);
	pill.title =
		state.base === "screenshot"
			? "Screenshot base: only the area visible at capture time"
			: "Live page base";
	host.style.pointerEvents = state.drawing ? "auto" : "none";
	canvas.classList.toggle("active", state.drawing);
}

// ---------- rendering ----------
let frame = 0;
function scheduleRender() {
	if (!frame) frame = requestAnimationFrame(render);
}

function resize() {
	const dpr = window.devicePixelRatio || 1;
	canvas.width = Math.round(innerWidth * dpr);
	canvas.height = Math.round(innerHeight * dpr);
	canvas.style.width = `${innerWidth}px`;
	canvas.style.height = `${innerHeight}px`;
	scheduleRender();
}

function render() {
	frame = 0;
	const dpr = window.devicePixelRatio || 1;
	const sx = scrollX,
		sy = scrollY;
	ctx.clearRect(0, 0, canvas.width, canvas.height);
	const toCanvas = (p) => ({ x: (p.x - sx) * dpr, y: (p.y - sy) * dpr });
	for (const s of state.strokes)
		paintStroke(ctx, s, toCanvas, dpr, {
			highlight: s.id === state.highlightId,
		});
	if (state.current)
		paintStroke(ctx, { id: "", points: state.current.points }, toCanvas, dpr);

	if (state.base === "screenshot" && state.screenshot) {
		const shot = state.screenshot;
		baseImg.hidden = false;
		baseImg.style.width = `${shot.width}px`;
		baseImg.style.height = `${shot.height}px`;
		baseImg.style.transform = `translate(${shot.scrollX - sx}px, ${shot.scrollY - sy}px)`;
	} else {
		baseImg.hidden = true;
	}
}

// ---------- capture ----------
function pagePoint(e) {
	return { x: e.clientX + scrollX, y: e.clientY + scrollY, t: now() };
}

canvas.addEventListener("pointerdown", (e) => {
	if (!state.drawing || e.button !== 0) return;
	e.preventDefault();
	canvas.setPointerCapture(e.pointerId);
	state.current = { pointerId: e.pointerId, points: [pagePoint(e)] };
	scheduleRender();
});

canvas.addEventListener("pointermove", (e) => {
	const cur = state.current;
	if (!cur || e.pointerId !== cur.pointerId) return;
	const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
	for (const ev of events.length ? events : [e]) cur.points.push(pagePoint(ev));
	scheduleRender();
});

function finishStroke(e) {
	const cur = state.current;
	if (!cur || e.pointerId !== cur.pointerId) return;
	state.current = null;
	cur.points.push(pagePoint(e));
	const stroke = makeStroke(`S${state.nextId++}`, cur.points);
	// Target resolution happens once, here, never on move.
	stroke.targets = resolveTargets(stroke, { ignore: [host] });
	state.strokes.push(stroke);
	scheduleRender();
	console.log(
		"[draw-and-talk] stroke",
		stroke.id,
		stroke.shape,
		stroke.targets,
	);
	send({ type: "dnt:stroke", stroke });
}
canvas.addEventListener("pointerup", finishStroke);
canvas.addEventListener("pointercancel", finishStroke);

pill.addEventListener("click", () => setDrawing(!state.drawing));

function setDrawing(on) {
	state.drawing = on;
	if (!on) state.current = null;
	updatePill();
	send({ type: "dnt:drawState", drawing: on });
}

function undo() {
	const s = state.strokes.pop();
	if (!s) return;
	state.nextId = Math.max(1, state.nextId - 1);
	scheduleRender();
	send({ type: "dnt:undo", id: s.id });
}

window.addEventListener(
	"keydown",
	(e) => {
		if (!state.drawing) return;
		if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			setDrawing(false);
		} else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
			e.preventDefault();
			e.stopPropagation();
			undo();
		}
	},
	true,
);

addEventListener("scroll", scheduleRender, { passive: true });
addEventListener("resize", resize);

// ---------- messaging ----------
function send(msg) {
	chrome.runtime.sendMessage(msg).catch(() => {
		// The panel may be closed; strokes stay on the page until it reopens.
	});
}

function viewport() {
	return {
		scrollX,
		scrollY,
		width: innerWidth,
		height: innerHeight,
		dpr: devicePixelRatio || 1,
	};
}

function setScreenshot(shot) {
	state.screenshot = shot;
	baseImg.src = shot.dataUrl;
}

const handlers = {
	"dnt:ping": () => ({ ok: true, strokes: state.strokes.length }),
	"dnt:init": (m) => {
		state.startEpoch = m.startEpoch;
		state.strokes = m.strokes || [];
		state.nextId = m.nextId || state.strokes.length + 1;
		state.base = m.base || "live-dom";
		if (m.screenshot) setScreenshot(m.screenshot);
		if (typeof m.drawing === "boolean") state.drawing = m.drawing;
		updatePill();
		scheduleRender();
		return { ok: true, url: location.href, title: document.title };
	},
	"dnt:setDraw": (m) => {
		setDrawing(m.on ?? !state.drawing);
		return { ok: true, drawing: state.drawing };
	},
	"dnt:undo": () => {
		undo();
		return { ok: true };
	},
	"dnt:clear": () => {
		state.strokes = [];
		state.nextId = 1;
		scheduleRender();
		return { ok: true };
	},
	"dnt:setBase": (m) => {
		state.base = m.base;
		if (m.screenshot) setScreenshot(m.screenshot);
		updatePill();
		scheduleRender();
		return { ok: true };
	},
	"dnt:highlight": (m) => {
		state.highlightId = m.id || null;
		scheduleRender();
		return { ok: true };
	},
	// Hide marks while the panel captures the page, so the PNG gets a clean base.
	"dnt:hide": () => {
		host.style.visibility = "hidden";
		return { ok: true, ...viewport() };
	},
	"dnt:show": () => {
		host.style.visibility = "";
		return { ok: true };
	},
	"dnt:viewport": () => ({ ok: true, ...viewport() }),
	// Fallback for the copy shortcut: the page has focus when the side panel does not.
	"dnt:writeClipboard": async (m) => {
		await navigator.clipboard.writeText(m.text);
		return { ok: true };
	},
};

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
	const handler = handlers[msg?.type];
	if (!handler) return false;
	Promise.resolve()
		.then(() => handler(msg))
		.then(reply, (err) =>
			reply({ ok: false, error: String(err?.message || err) }),
		);
	return true;
});

resize();
updatePill();
send({ type: "dnt:ready", url: location.href });
