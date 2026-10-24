import { INK, inkOutline } from "./ink.js";
import { describeSketch } from "./shape.js";
import { recognizeShape } from "./shape-recognition.js";
import { makePayload } from "./timeline.js";

const NS = "http://www.w3.org/2000/svg";
const CLOSED = new Set(["circle", "square", "triangle"]);
const isPage = (s) => /^(html|body|main)([.#:]|$)/i.test(s || "");
const round2 = (n) => Math.round(n * 100) / 100;
const sel = (el) => {
	if (!el) return null;
	let s = el.tagName.toLowerCase();
	if (el.id) s += "#" + el.id;
	if (typeof el.className === "string" && el.className.trim())
		s += "." + el.className.trim().split(/\s+/).slice(0, 2).join(".");
	return s;
};
function domRef(el) {
	if (!el || ["html", "body"].includes(el.tagName.toLowerCase())) return "";
	const parts = [];
	let node = el;
	while (
		node?.tagName &&
		node.tagName.toLowerCase() !== "html" &&
		parts.length < 6
	) {
		let part = sel(node);
		if (node.parentElement && !node.id) {
			const siblings = Array.from(node.parentElement.children).filter(
				(e) => e.tagName === node.tagName,
			);
			if (siblings.length > 1)
				part += ":nth-of-type(" + (siblings.indexOf(node) + 1) + ")";
		}
		parts.unshift(part);
		if (node.id || node.tagName.toLowerCase() === "body") break;
		node = node.parentElement;
	}
	const label = /^(button|a|h[1-6]|span|p)$/i.test(el.tagName)
		? (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 50)
		: "";
	return (parts.join(" > ") + (label ? ' "' + label + '"' : "")).slice(0, 200);
}
function svgEl(doc, tag, attrs = {}, text) {
	const n = doc.createElementNS(NS, tag);
	for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
	if (text != null) n.textContent = text;
	return n;
}

// Imperative drawing lives in the inert same-origin iframe; Svelte never re-renders its contents.
// The human mark is drawn first and left alone; the machine's reading of it (corner
// brackets, asterisk, label) fades in afterwards on a separate layer.
export function attachDrawing(
	iframe,
	{ elapsed, onStart, onMove, onFinish, cursor = "crosshair" },
) {
	const doc = iframe.contentDocument;
	if (!doc?.body) return { clear() {}, setCursor() {} };
	const overlay = doc.createElement("canvas");
	overlay.style.cssText =
		"position:absolute;left:0;top:0;width:100%;z-index:2147483647;touch-action:none;";
	overlay.style.cursor = cursor;
	doc.body.appendChild(overlay);
	overlay.width = doc.documentElement.clientWidth;
	overlay.height = Math.max(
		doc.body.scrollHeight,
		doc.documentElement.scrollHeight,
		doc.documentElement.clientHeight,
	);
	overlay.style.height = overlay.height + "px";
	const svg = svgEl(doc, "svg", {
		viewBox: `0 0 ${overlay.width} ${overlay.height}`,
	});
	svg.style.cssText = `position:absolute;left:0;top:0;width:100%;height:${overlay.height}px;z-index:2147483647;pointer-events:none;overflow:visible;`;
	// a faint displacement so the edge of the ink reads as ink on paper, not a vector
	const defs = svgEl(doc, "defs");
	const filter = svgEl(doc, "filter", {
		id: "calliope-ink",
		x: "-5%",
		y: "-5%",
		width: "110%",
		height: "110%",
	});
	filter.append(
		svgEl(doc, "feTurbulence", {
			type: "fractalNoise",
			baseFrequency: "0.8",
			numOctaves: "1",
			seed: "7",
			result: "grain",
		}),
		svgEl(doc, "feDisplacementMap", {
			in: "SourceGraphic",
			in2: "grain",
			scale: "1.1",
		}),
	);
	defs.append(filter);
	const ink = svgEl(doc, "g"),
		notes = svgEl(doc, "g");
	svg.append(defs, ink, notes);
	doc.body.appendChild(svg);
	let cur = null,
		count = 0;
	const hit = (x, y) =>
		(doc.elementsFromPoint(x, y) || []).find(
			(el) => el !== overlay && el !== svg,
		) || null;
	const point = (e) => {
		const r = overlay.getBoundingClientRect(),
			el = hit(e.clientX, e.clientY),
			box = el?.getBoundingClientRect();
		return {
			x: Math.round(e.clientX - r.left),
			y: Math.round(e.clientY - r.top),
			utc: new Date().toISOString(),
			selector: sel(el) || "",
			text: (el?.textContent || "").trim().slice(0, 200),
			rect: box
				? {
						x: Math.round(box.x),
						y: Math.round(box.y),
						width: Math.round(box.width),
						height: Math.round(box.height),
					}
				: null,
		};
	};
	const render = (s) => s.pathEl.setAttribute("d", inkOutline(s.pts));
	overlay.addEventListener("pointerdown", (e) => {
		if (cur) return;
		try {
			overlay.setPointerCapture(e.pointerId);
		} catch (_) {}
		const p = point(e),
			s = sel(hit(e.clientX, e.clientY));
		const bytes = new Uint8Array(16);
		crypto.getRandomValues(bytes);
		cur = {
			id: Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""),
			name: "stroke_" + String(++count).padStart(2, "0"),
			tool: "pen",
			t: elapsed(),
			pts: [p],
			elements: s ? [s] : [],
		};
		cur.pathEl = svgEl(doc, "path", {
			fill: INK.pen.color,
			filter: "url(#calliope-ink)",
		});
		render(cur);
		ink.appendChild(cur.pathEl);
		onStart(cur);
		e.preventDefault();
	});
	overlay.addEventListener("pointermove", (e) => {
		if (!cur) return;
		const p = point(e);
		cur.pts.push(p);
		const s = sel(hit(e.clientX, e.clientY));
		if (s && !cur.elements.includes(s)) cur.elements.push(s);
		render(cur);
		onMove(cur);
		e.preventDefault();
	});
	// What the mark most plausibly refers to. Closed shapes: the element at their centre,
	// scored by the shape recogniser. A pen line is read by where it ends (an arrow
	// points with its tip). The score is the share of counted points on that element.
	function resolveTarget(payload) {
		const r = overlay.getBoundingClientRect(),
			b = payload.bbox;
		if (CLOSED.has(payload.shape)) {
			const el = hit(r.left + b.x + b.width / 2, r.top + b.y + b.height / 2),
				s = sel(el);
			if (!el || isPage(s)) return null;
			const box = el.getBoundingClientRect();
			return {
				selector: s,
				tag: el.tagName.toLowerCase(),
				label: (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 50),
				rect: {
					x: Math.round(box.x - r.left),
					y: Math.round(box.y - r.top),
					width: Math.round(box.width),
					height: Math.round(box.height),
				},
				confidence: round2(recognizeShape(payload.pts).confidence || 0),
				basis: "shape",
			};
		}
		const pts = payload.pts.slice(-6),
			tally = new Map();
		for (const p of pts)
			if (p.selector && !isPage(p.selector))
				tally.set(p.selector, (tally.get(p.selector) || 0) + 1);
		const [best, n] = [...tally].sort((a, b) => b[1] - a[1])[0] || [];
		if (!best) return null;
		const p = pts.findLast((q) => q.selector === best && q.rect);
		return {
			selector: best,
			tag: best.split(/[#.]/)[0],
			label: (p?.text || "").replace(/\s+/g, " ").slice(0, 50),
			rect: p
				? {
						x: Math.round(p.rect.x - r.left),
						y: Math.round(p.rect.y - r.top),
						width: p.rect.width,
						height: p.rect.height,
					}
				: null,
			confidence: round2(n / pts.length),
			basis: "tip",
		};
	}
	function reveal(stroke, payload, target) {
		const g = svgEl(doc, "g", {
			style: "opacity:0;transition:opacity .45s ease",
		});
		const red = {
			stroke: INK.pen.color,
			"stroke-width": "1.4",
			fill: "none",
			"stroke-linecap": "round",
		};
		// brackets only around what a closed shape encloses; open marks are labelled at themselves
		const enclosed = target?.basis === "shape";
		const box = enclosed
			? target.rect
			: {
					x: payload.bbox.x,
					y: payload.bbox.y,
					width: payload.bbox.width,
					height: payload.bbox.height,
				};
		if (enclosed) {
			const p = 6,
				L = 10,
				x0 = box.x - p,
				y0 = box.y - p,
				x1 = box.x + box.width + p,
				y1 = box.y + box.height + p;
			g.append(
				svgEl(doc, "path", {
					...red,
					d: `M ${x0} ${y0 + L} V ${y0} H ${x0 + L} M ${x1 - L} ${y0} H ${x1} V ${y0 + L} M ${x1} ${y1 - L} V ${y1} H ${x1 - L} M ${x0 + L} ${y1} H ${x0} V ${y1 - L}`,
				}),
			);
		}
		const score = !target
			? ""
			: target.basis === "shape"
				? ` · shape ${target.confidence.toFixed(2)}`
				: ` · ${target.basis} ${Math.round(target.confidence * 100)}%`;
		const lines = [
			`${stroke.name} → ${target?.selector || payload.shape}`,
			`${payload.shape} · ${Math.round(box.width)} × ${Math.round(box.height)}${score}`,
		];
		const label = svgEl(doc, "g", {
			"font-family": '"JetBrains Mono","SF Mono",ui-monospace,Menlo,monospace',
			"font-size": "10.5",
		});
		const bg = svgEl(doc, "rect", {
			fill: "#FFFFFF",
			stroke: "rgba(23,23,23,.18)",
			rx: "2",
		});
		label.append(bg);
		lines.forEach((t, i) =>
			label.append(
				svgEl(
					doc,
					"text",
					{ x: 8, y: 15 + i * 14, fill: i ? "#6E685C" : "#171717" },
					t,
				),
			),
		);
		g.append(label);
		notes.append(g);
		const w = label.getBBox().width + 16,
			h = lines.length * 14 + 8;
		bg.setAttribute("width", w);
		bg.setAttribute("height", h);
		const lx = Math.max(4, Math.min(overlay.width - w - 4, box.x)),
			ly = Math.min(overlay.height - h - 4, box.y + box.height + 14);
		label.setAttribute("transform", `translate(${lx} ${ly})`);
		// the human mark first; the interpretation a beat later
		setTimeout(() => {
			g.style.opacity = "1";
		}, 260);
	}
	const finish = () => {
		if (!cur) return;
		const stroke = cur;
		cur = null;
		const xs = stroke.pts.map((p) => p.x),
			ys = stroke.pts.map((p) => p.y);
		const r = overlay.getBoundingClientRect();
		const enclosed = domRef(
			hit(
				r.left + (Math.min(...xs) + Math.max(...xs)) / 2,
				r.top + (Math.min(...ys) + Math.max(...ys)) / 2,
			),
		);
		const payload = makePayload(
			stroke,
			elapsed(),
			{ width: overlay.width, height: overlay.height },
			enclosed,
		);
		const target = resolveTarget(payload);
		onFinish(stroke, payload, describeSketch(payload), target);
		reveal(stroke, payload, target);
	};
	overlay.addEventListener("pointerup", finish);
	overlay.addEventListener("pointercancel", finish);
	return {
		clear() {
			ink.replaceChildren();
			notes.replaceChildren();
		},
		// the muse hand arrives after the image decodes, so the cursor can change later
		setCursor(value) {
			overlay.style.cursor = value;
		},
	};
}
