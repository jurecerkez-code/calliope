// DOM target resolution for a finished stroke.
// Runs once per stroke end (never on pointermove) and keeps the top three candidates.

const SKIP_TAGS = new Set([
	"HTML",
	"BODY",
	"HEAD",
	"SCRIPT",
	"STYLE",
	"NOSCRIPT",
]);
const MAX_SAMPLES = 40;
const MAX_TARGETS = 3;

// Generated ids (React, Ember, hashes) are unstable, so they are not used as anchors.
const looksGenerated = (id) =>
	/^(?:[:_]|ember\d|react-)|\d{4,}|[a-f0-9]{8,}/i.test(id);

function isUnique(doc, selector) {
	try {
		return doc.querySelectorAll(selector).length === 1;
	} catch {
		return false;
	}
}

export function selectorFor(el) {
	const doc = el.ownerDocument;
	const esc = (s) => CSS.escape(s);
	if (el.id && !looksGenerated(el.id) && isUnique(doc, `#${esc(el.id)}`))
		return `#${esc(el.id)}`;
	for (const attr of [
		"data-testid",
		"data-test",
		"data-qa",
		"name",
		"aria-label",
	]) {
		const v = el.getAttribute(attr);
		if (v && v.length < 60) {
			const s = `${el.localName}[${attr}="${CSS.escape(v)}"]`;
			if (isUnique(doc, s)) return s;
		}
	}

	const parts = [];
	let node = el;
	while (
		node &&
		node.nodeType === 1 &&
		node.localName !== "html" &&
		parts.length < 6
	) {
		if (node !== el && node.id && !looksGenerated(node.id)) {
			parts.unshift(`#${esc(node.id)}`);
			break;
		}
		let part = node.localName;
		const cls = [...node.classList]
			.filter((c) => !looksGenerated(c) && c.length < 30)
			.slice(0, 2);
		if (cls.length) part += cls.map((c) => `.${esc(c)}`).join("");
		const parent = node.parentElement;
		if (parent) {
			const same = [...parent.children].filter(
				(c) => c.localName === node.localName,
			);
			if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
		}
		parts.unshift(part);
		const sel = parts.join(" > ");
		if (isUnique(doc, sel)) return sel;
		node = parent;
	}
	return parts.join(" > ");
}

export function labelFor(el) {
	const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
	const direct =
		el.getAttribute("aria-label") ||
		el.getAttribute("alt") ||
		el.getAttribute("title") ||
		el.getAttribute("placeholder");
	if (clean(direct)) return clean(direct).slice(0, 80);
	const labelledBy = el.getAttribute("aria-labelledby");
	if (labelledBy) {
		const ref = el.ownerDocument.getElementById(labelledBy.split(" ")[0]);
		if (ref && clean(ref.textContent))
			return clean(ref.textContent).slice(0, 80);
	}
	const text = clean(el.innerText || el.textContent);
	if (text) return text.length > 80 ? `${text.slice(0, 77)}...` : text;
	const cls = [...el.classList].slice(0, 2).join(".");
	return cls ? `${el.localName}.${cls}` : el.localName;
}

// Evenly spaced samples along the stroke, plus an interior grid for loops so the
// enclosed element wins over whatever the pen happened to cross.
function samplePoints(stroke, toClient) {
	const pts = stroke.points;
	const out = [];
	const step = Math.max(1, Math.floor(pts.length / MAX_SAMPLES));
	for (let i = 0; i < pts.length; i += step)
		out.push({ ...toClient(pts[i]), weight: 1 });
	if (
		stroke.shape === "closed-loop" ||
		stroke.shape === "dot" ||
		stroke.shape === "scribble"
	) {
		const b = stroke.bbox;
		for (let gx = 1; gx <= 4; gx++) {
			for (let gy = 1; gy <= 4; gy++) {
				out.push({
					...toClient({ x: b.x + (b.w * gx) / 5, y: b.y + (b.h * gy) / 5 }),
					weight: 2,
				});
			}
		}
	}
	if (stroke.shape === "underline") {
		// The thing being underlined sits just above the line.
		const lift = 12;
		for (let i = 0; i < pts.length; i += step) {
			out.push({ ...toClient({ x: pts[i].x, y: pts[i].y - lift }), weight: 2 });
		}
	}
	if (stroke.shape === "line") {
		// Arrow heads point at their target, so the end point counts extra.
		out.push({ ...toClient(stroke.anchor), weight: 6 });
	}
	return out;
}

function iou(a, b) {
	const x1 = Math.max(a.x, b.x),
		y1 = Math.max(a.y, b.y);
	const x2 = Math.min(a.x + a.w, b.x + b.w),
		y2 = Math.min(a.y + a.h, b.y + b.h);
	const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
	const union = a.w * a.h + b.w * b.h - inter;
	return union > 0 ? inter / union : 0;
}

// stroke: record from makeStroke (page coordinates).
// opts.ignore: elements that must never be returned (the overlay host).
// opts.scroll: { x, y } current scroll offset, used to convert page to client coordinates.
export function resolveTargets(
	stroke,
	{ doc = document, ignore = [], scroll } = {},
) {
	const sx = scroll ? scroll.x : doc.defaultView.scrollX;
	const sy = scroll ? scroll.y : doc.defaultView.scrollY;
	const toClient = (p) => ({ x: p.x - sx, y: p.y - sy });
	const vw = doc.documentElement.clientWidth;
	const vh = doc.documentElement.clientHeight;
	const ignored = (el) => ignore.some((i) => i === el || i.contains(el));

	const hits = new Map();
	let totalWeight = 0;
	for (const s of samplePoints(stroke, toClient)) {
		if (s.x < 0 || s.y < 0 || s.x >= vw || s.y >= vh) continue;
		totalWeight += s.weight;
		// Count only the topmost few elements at each point: deeper ancestors are
		// credited through the box-fit term instead.
		let depth = 0;
		for (const el of doc.elementsFromPoint(s.x, s.y)) {
			if (ignored(el) || SKIP_TAGS.has(el.tagName)) continue;
			hits.set(el, (hits.get(el) || 0) + s.weight / (1 + depth * 0.35));
			if (++depth >= 4) break;
		}
	}
	if (!totalWeight) return [];

	const sbox = { ...stroke.bbox, ...toClient(stroke.bbox) };
	// Give dots and thin lines some area so box fit stays meaningful.
	const pad = stroke.shape === "dot" ? 10 : 0;
	const strokeBox = {
		x: sbox.x - pad,
		y: sbox.y - pad,
		w: sbox.w + pad * 2,
		h: sbox.h + pad * 2,
	};
	const viewportArea = vw * vh;

	const scored = [];
	for (const [el, weight] of hits) {
		const r = el.getBoundingClientRect();
		if (r.width < 2 || r.height < 2) continue;
		const coverage = Math.min(1, weight / totalWeight);
		const rect = { x: r.left, y: r.top, w: r.width, h: r.height };
		let fit = iou(strokeBox, rect);
		if (stroke.shape === "underline") {
			const overlap = Math.max(
				0,
				Math.min(rect.x + rect.w, strokeBox.x + strokeBox.w) -
					Math.max(rect.x, strokeBox.x),
			);
			const widthFit = overlap / Math.max(rect.w, strokeBox.w);
			const nearBottom = Math.abs(rect.y + rect.h - strokeBox.y) < 24 ? 1 : 0.3;
			fit = Math.max(fit, widthFit * nearBottom);
		}
		if (stroke.shape === "line") {
			const a = toClient(stroke.anchor);
			const inside =
				a.x >= rect.x &&
				a.x <= rect.x + rect.w &&
				a.y >= rect.y &&
				a.y <= rect.y + rect.h;
			fit = inside
				? Math.max(fit, Math.min(1, 4000 / (rect.w * rect.h + 1)) * 0.8 + 0.2)
				: fit * 0.5;
		}
		// Page-sized wrappers match everything; push them down.
		const sizePenalty = (rect.w * rect.h) / viewportArea > 0.6 ? 0.4 : 1;
		const score = (coverage * 0.55 + fit * 0.45) * sizePenalty;
		scored.push({ el, score });
	}

	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, MAX_TARGETS).map(({ el, score }) => ({
		selector: selectorFor(el),
		label: labelFor(el),
		tag: el.localName,
		confidence: Math.round(Math.min(1, score) * 100) / 100,
	}));
}
