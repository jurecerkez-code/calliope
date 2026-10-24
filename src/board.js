// Blank canvas board: an SVG the user draws on directly (no website underneath).
// Imperative like drawing.js; Svelte never re-renders the SVG's contents.
// Styles are inline attributes so the PNG export looks the same as the screen.
import { INK as BRAND_INK, inkOutline } from "./ink.js";

const NS = "http://www.w3.org/2000/svg";
export const BOARD = { width: 2400, height: 1600 };
const PAPER = "#FFFFFF";

function el(tag, attrs = {}, text) {
	const node = document.createElementNS(NS, tag);
	for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
	if (text != null) node.textContent = text;
	return node;
}
const render = (s) => s.path.setAttribute("d", inkOutline(s.points));

export function attachBoard(svg, { elapsed, onStroke }) {
	svg.setAttribute("viewBox", `0 0 ${BOARD.width} ${BOARD.height}`);
	svg.setAttribute("width", BOARD.width);
	svg.setAttribute("height", BOARD.height);
	svg.replaceChildren();
	const defs = el("defs");
	const grid = el("pattern", {
		id: "board-grid",
		width: 24,
		height: 24,
		patternUnits: "userSpaceOnUse",
	});
	grid.append(el("circle", { cx: 1, cy: 1, r: 1, fill: "rgba(23,23,23,0.13)" }));
	defs.append(grid);
	const bg = el("rect", {
		x: 0,
		y: 0,
		width: BOARD.width,
		height: BOARD.height,
		fill: PAPER,
	});
	const dots = el("rect", {
		x: 0,
		y: 0,
		width: BOARD.width,
		height: BOARD.height,
		fill: "url(#board-grid)",
	});
	const ink = el("g", { "data-layer": "ink" });
	const labels = el("g", {
		"data-layer": "labels",
		"font-family": "JetBrains Mono, SF Mono, Menlo, monospace",
	});
	svg.append(defs, bg, dots, ink, labels);

	const strokes = []; // {id, tool, points, path}
	let cur = null,
		next = 1;
	const point = (e) => {
		const r = svg.getBoundingClientRect();
		return { x: e.clientX - r.left, y: e.clientY - r.top, t: elapsed() };
	};
	svg.addEventListener("pointerdown", (e) => {
		if (cur || e.button !== 0) return;
		try {
			svg.setPointerCapture(e.pointerId);
		} catch (_) {}
		const p = point(e);
		cur = {
			id: `S${next++}`,
			tool: "pen",
			points: [p],
			pointerId: e.pointerId,
			path: el("path", { fill: BRAND_INK.pen.color }),
		};
		render(cur);
		ink.append(cur.path);
		e.preventDefault();
	});
	svg.addEventListener("pointermove", (e) => {
		if (!cur || e.pointerId !== cur.pointerId) return;
		const events = e.getCoalescedEvents?.() || [];
		for (const ev of events.length ? events : [e]) cur.points.push(point(ev));
		render(cur);
		e.preventDefault();
	});
	const finish = (e) => {
		if (!cur || e.pointerId !== cur.pointerId) return;
		const s = cur;
		cur = null;
		s.points.push(point(e));
		render(s);
		strokes.push(s);
		onStroke({ id: s.id, tool: s.tool, points: s.points });
	};
	svg.addEventListener("pointerup", finish);
	svg.addEventListener("pointercancel", finish);

	return {
		strokes: () =>
			strokes.map(({ id, tool, points }) => ({ id, tool, points })),
		undo() {
			const s = strokes.pop();
			if (s) {
				s.path.remove();
				next--;
			}
			return s?.id || null;
		},
		clear() {
			strokes.length = 0;
			next = 1;
			ink.replaceChildren();
			labels.replaceChildren();
		},
		// Writes ids and spoken labels next to each node and edge.
		setLabels({ nodes, edges, recs }) {
			labels.replaceChildren();
			for (const n of nodes) {
				const tag = el(
					"text",
					{
						x: n.bbox.x + 4,
						y: n.bbox.y - 8,
						"font-size": 12,
						fill: "#6E685C",
					},
					n.id,
				);
				labels.append(tag);
				if (n.label) {
					labels.append(
						el(
							"text",
							{
								x: n.bbox.x + n.bbox.w / 2,
								y: n.bbox.y + n.bbox.h / 2 + 6,
								"font-size": 22,
								"font-style": "italic",
								"font-family": "Hoefler Text, Baskerville, Georgia, serif",
								fill: "#171717",
								"text-anchor": "middle",
							},
							n.label,
						),
					);
				}
			}
			for (const e of edges) {
				// halfway between where the stroke starts and its tip, so it clears both nodes
				const r = recs.find((x) => x.id === e.strokeId);
				const mid = {
					x: (r.points[0].x + r.tip.x) / 2,
					y: (r.points[0].y + r.tip.y) / 2,
				};
				labels.append(
					el(
						"text",
						{
							x: mid.x,
							y: mid.y - 10,
							"font-size": 12,
							fill: e.label ? "#111111" : "#6E685C",
							"text-anchor": "middle",
						},
						e.label ? `${e.id} ${e.label}` : e.id,
					),
				);
			}
		},
		// PNG of the drawn area (plus a margin), at 2x for legibility.
		async exportPng() {
			if (!strokes.length) return null;
			const box = svg.querySelector('[data-layer="ink"]').getBBox();
			const lab = labels.getBBox();
			const x0 = Math.max(0, Math.min(box.x, lab.width ? lab.x : box.x) - 40);
			const y0 = Math.max(0, Math.min(box.y, lab.height ? lab.y : box.y) - 40);
			const x1 = Math.min(
				BOARD.width,
				Math.max(box.x + box.width, lab.x + lab.width) + 40,
			);
			const y1 = Math.min(
				BOARD.height,
				Math.max(box.y + box.height, lab.y + lab.height) + 40,
			);
			const w = x1 - x0,
				h = y1 - y0,
				scale = 2;
			const copy = svg.cloneNode(true);
			copy.setAttribute("xmlns", NS);
			copy.setAttribute("viewBox", `${x0} ${y0} ${w} ${h}`);
			copy.setAttribute("width", w * scale);
			copy.setAttribute("height", h * scale);
			const img = new Image();
			img.src =
				"data:image/svg+xml;charset=utf-8," +
				encodeURIComponent(new XMLSerializer().serializeToString(copy));
			await img.decode();
			const canvas = document.createElement("canvas");
			canvas.width = w * scale;
			canvas.height = h * scale;
			canvas.getContext("2d").drawImage(img, 0, 0);
			return await new Promise((resolve) =>
				canvas.toBlob(resolve, "image/png"),
			);
		},
	};
}
