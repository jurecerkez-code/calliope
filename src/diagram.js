// Blank canvas: turns strokes and timed speech into a diagram an agent can read.
// Closed shapes become nodes, strokes from one node to another become edges, and
// "this is the API gateway" said while (or just after) drawing names the node.
// Pure functions over plain data; no DOM.

import { buildTimeline, fuse } from "./lib/fusion.js";
import { classifyShape, makeStroke } from "./lib/strokes.js";
import { recognizeShape } from "./shape-recognition.js";

const NEAR = 28; // px around a node that still counts as touching it
const SMALL = 40; // strokes up to this size near an edge end are arrowheads
const NODE_SHAPES = { circle: "circle", square: "box", triangle: "triangle" };

const centre = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
const diag = (b) => Math.hypot(b.w, b.h);
const inside = (p, b, pad = 0) =>
	p.x >= b.x - pad &&
	p.x <= b.x + b.w + pad &&
	p.y >= b.y - pad &&
	p.y <= b.y + b.h + pad;

// The node a point touches; the smallest one wins when nodes are nested.
function nodeAt(nodes, p) {
	let best = null;
	for (const n of nodes) {
		if (
			inside(p, n.bbox, NEAR) &&
			(!best || n.bbox.w * n.bbox.h < best.bbox.w * best.bbox.h)
		)
			best = n;
	}
	return best;
}

// The point of an open stroke farthest from where it started: the arrow tip, even
// when the arrowhead was drawn in the same stroke.
function tipOf(points) {
	const s = points[0];
	return points.reduce(
		(far, p) =>
			Math.hypot(p.x - s.x, p.y - s.y) > Math.hypot(far.x - s.x, far.y - s.y)
				? p
				: far,
		s,
	);
}

// Both ends are resolved against marks already present when the arrow is drawn.
export function connect(nodes, points) {
	const tip = tipOf(points);
	return { from: nodeAt(nodes, points[0]), to: nodeAt(nodes, tip), tip };
}

// strokes: [{id, tool, points:[{x,y,t}]}] in board CSS pixels, t in session ms.
export function classifyStrokes(strokes) {
	return strokes.map((s) => {
		const rec = { ...makeStroke(s.id, s.points), tool: s.tool || "pen" };
		const recognised =
			rec.tool === "pen" ? recognizeShape(s.points).shape : "highlight";
		rec.kind =
			NODE_SHAPES[recognised] ||
			(rec.tool === "pen" && rec.shape === "closed-loop"
				? "blob"
				: recognised === "highlight"
					? "highlight"
					: rec.shape);
		rec.tip = tipOf(rec.points);
		return rec;
	});
}

const STOP =
	/[,.;:!?]|\s(?:and|which|that|who|where|because|so|then|but|while|when|with|to|for|from|in|on|of)\s/i;
const ARTICLE = /^(?:the|a|an|our|my|your|their|some)\s+/i;

function cleanName(raw) {
	if (!raw) return "";
	let s = ` ${raw} `;
	const cut = s.search(STOP);
	if (cut > 0) s = s.slice(0, cut);
	s = s.trim().replace(ARTICLE, "").replace(/\s+/g, " ");
	const words = s.split(" ").filter(Boolean).slice(0, 6);
	return words
		.join(" ")
		.replace(/[^\p{L}\p{N}\s'&/+-]/gu, "")
		.trim();
}

const NOUN =
	"(?:\\s+(?:box|one|node|thing|circle|square|triangle|shape|part|bit|block|service|component|piece))?";

// Name for a node, from the words after the pointing word.
// "this is the API gateway" / "this box is called auth" / "here we have the queue"
// / "call this the cache". Returns '' when the sentence does not name anything.
export function nameFrom(text, word) {
	const t = ` ${text.replace(/\b(here|that|there|it)'s\b/gi, "$1 is")} `;
	if (word) {
		const w = word.toLowerCase();
		const call = new RegExp(`\\bcall\\s+${w}${NOUN}\\s+(.+)`, "i").exec(t);
		if (call) return cleanName(call[1]);
		const is = new RegExp(
			`\\b${w}${NOUN}\\s+(?:is|will be|represents|stands for|means|=)\\s+(?:called\\s+|named\\s+|going to be\\s+)?(.+)`,
			"i",
		).exec(t);
		if (is) return cleanName(is[1]);
		if (w === "here" || w === "there") {
			const here = new RegExp(
				`\\b${w}\\s+(?:we have|we've got|we got|you have|sits|lives|goes|comes|are|is)\\s+(.+)`,
				"i",
			).exec(t);
			if (here) return cleanName(here[1]);
		}
		return "";
	}
	// No pointing word: only explicit introductions count ("we have the queue").
	const intro = /\b(?:we have|we've got|there is)\s+(.+)/i.exec(t);
	return intro ? cleanName(intro[1]) : "";
}

// Label for an edge: what the arrow does. "this sends the token" -> "sends the token".
export function edgeLabelFrom(text, word) {
	const named = nameFrom(text, word);
	if (named) return named;
	if (!word) return "";
	const m = new RegExp(
		`\\b${word}(?:\\s+(?:arrow|line|connection|link|edge|flow|one))?\\s+(.+)`,
		"i",
	).exec(text);
	if (!m) return "";
	return m[1]
		.split(/[,.;:!?]|\s(?:and|but|because|so|then)\s/i)[0]
		.trim()
		.split(/\s+/)
		.slice(0, 6)
		.join(" ");
}

export function buildDiagram(strokes, utterances) {
	const recs = classifyStrokes(strokes);
	const nodes = [];
	const edges = [];
	const annotations = [];
	const owner = {}; // strokeId -> {type, item}

	for (const r of recs) {
		if (["box", "circle", "triangle", "blob"].includes(r.kind)) {
			const n = {
				id: `N${nodes.length + 1}`,
				shape: r.kind,
				label: "",
				bbox: r.bbox,
				strokeId: r.id,
				said: [],
			};
			nodes.push(n);
			owner[r.id] = { type: "node", item: n };
		}
	}
	// Edges first, so small marks next to an edge's tip can be read as its arrowhead.
	for (const r of recs) {
		if (owner[r.id] || r.kind === "highlight" || diag(r.bbox) <= SMALL)
			continue;
		const from = nodeAt(nodes, r.points[0]);
		const to = nodeAt(nodes, r.tip);
		if (from && to && from !== to) {
			const e = {
				id: `E${edges.length + 1}`,
				from: from.id,
				to: to.id,
				label: "",
				strokeId: r.id,
				arrowhead: null,
				said: [],
			};
			edges.push(e);
			owner[r.id] = { type: "edge", item: e };
		}
	}
	for (const r of recs) {
		if (owner[r.id]) continue;
		if (diag(r.bbox) <= SMALL) {
			const e = edges.find((x) => {
				const tip = recs.find((q) => q.id === x.strokeId).tip;
				return (
					Math.hypot(centre(r.bbox).x - tip.x, centre(r.bbox).y - tip.y) <=
					SMALL
				);
			});
			if (e && !e.arrowhead) {
				e.arrowhead = r.id;
				owner[r.id] = { type: "edge", item: e };
				continue;
			}
		}
		const pointsAt = r.kind === "line" ? nodeAt(nodes, r.tip) : null;
		const near = pointsAt || nodeAt(nodes, centre(r.bbox));
		const a = {
			id: `A${annotations.length + 1}`,
			kind: pointsAt ? "pointer" : r.kind,
			node: near ? near.id : null,
			bbox: r.bbox,
			strokeId: r.id,
		};
		annotations.push(a);
		owner[r.id] = { type: "annotation", item: a };
	}

	// Speech: bind pointing words to strokes by time (src/lib/fusion.js), then
	// read names from the words that follow.
	const fused = fuse(
		utterances.filter((u) => u.final !== false && u.text),
		recs,
	);
	const byId = (id) => nodes.find((n) => n.id === id);
	for (const u of fused) {
		u.references = u.references.map((ref) => {
			if (!ref.strokeId) return { ...ref, element: null };
			let el = owner[ref.strokeId];
			// Pointing at a node with a pointer or a mark next to it still means the node.
			if (el?.type === "annotation" && el.item.node)
				el = { type: "node", item: byId(el.item.node) };
			if (!el) return { ...ref, element: null };
			const item = el.item;
			if (!item.said.includes(u.id)) item.said.push(u.id);
			if (el.type === "node" && !item.label)
				item.label = nameFrom(u.text, ref.word);
			if (el.type === "edge" && !item.label)
				item.label = edgeLabelFrom(u.text, ref.word);
			return { ...ref, element: item.id };
		});
	}
	return { recs, nodes, edges, annotations, utterances: fused };
}

const q = (s) => `"${String(s).replace(/"/g, "#quot;")}"`;
const MERMAID_SHAPE = {
	box: (l) => `[${l}]`,
	circle: (l) => `((${l}))`,
	triangle: (l) => `{${l}}`,
	blob: (l) => `(${l})`,
};

export function toMermaid({ nodes, edges }) {
	const lines = ["flowchart LR"];
	for (const n of nodes)
		lines.push(`  ${n.id}${MERMAID_SHAPE[n.shape](q(n.label || n.id))}`);
	for (const e of edges)
		lines.push(`  ${e.from} -->${e.label ? `|${q(e.label)}|` : ""} ${e.to}`);
	return lines.join("\n");
}

export function buildCanvasPacket({ elapsedMs, strokes, utterances }) {
	const d = buildDiagram(strokes, utterances);
	const mermaid = toMermaid(d);
	return {
		session: {
			mode: "blank-canvas",
			elapsedMs: Math.round(elapsedMs),
			coordinates: "board CSS pixels, origin top left",
		},
		nodes: d.nodes,
		edges: d.edges,
		annotations: d.annotations,
		utterances: d.utterances.map((u) => ({
			id: u.id,
			startMs: u.startMs,
			endMs: u.endMs,
			text: u.text,
			source: u.source,
			intent: u.intent,
			references: u.references.map((r) => ({
				word: r.word,
				atMs: r.atMs,
				strokeId: r.strokeId,
				element: r.element,
			})),
		})),
		strokes: d.recs.map((r) => ({
			id: r.id,
			startMs: r.startMs,
			endMs: r.endMs,
			kind: r.kind,
			bbox: r.bbox,
		})),
		timeline: buildTimeline(d.recs, d.utterances),
		mermaid,
	};
}

export function canvasPacketText(packet) {
	return [
		`Calliope canvas sketch: ${packet.nodes.length} node(s), ${packet.edges.length} edge(s), ${packet.utterances.length} spoken sentence(s). The user drew this while explaining it out loud. Nodes are the shapes they drew, edges are strokes from one shape to another, and labels come from what they said while pointing. "said" lists the sentence ids about each element; read those sentences for intent. Times are ms from session start.`,
		"",
		"Diagram (Mermaid):",
		"```mermaid",
		packet.mermaid,
		"```",
		"",
		"Full context (JSON):",
		"```json",
		JSON.stringify(packet, null, 2),
		"```",
		"",
		"The PNG snapshot shows the original drawing; ids N1, E1, ... are written next to each element.",
	].join("\n");
}

// Website mode reads settled marks in drawing order. An arrow cannot acquire
// a source that was circled later, even if both end up in the same APPLY turn.
const MARK_SHAPES = new Set(["circle", "square", "triangle"]);

export function websiteRelations(items) {
	const marks = [];
	const relations = [];
	for (const item of items) {
		const p = item.strokes ? item.strokes[0] : item;
		if (item.shape === "x") continue;
		const points = p.pts.map(q => ({ x: q.x, y: q.y }));
		const bbox = { x: p.bbox.x, y: p.bbox.y, w: p.bbox.width, h: p.bbox.height };
		const target = (MARK_SHAPES.has(p.shape) && p.enclosed_element) || p.elements?.[0] || "";
		if (MARK_SHAPES.has(p.shape) || p.tool === "highlighter" || classifyShape(points) === "closed-loop") {
			marks.push({ id: p.id, bbox, target });
		} else if (p.tool === "pen" && diag(bbox) > SMALL) {
			const { from, to, tip } = connect(marks, p.pts);
			if ((!from && !to) || (from && from === to)) continue;
			relations.push({
				kind: from && to ? "link" : from ? "move" : "point",
				arrow: p.id,
				from: from ? { stroke: from.id, target: from.target } : null,
				to: to
					? { stroke: to.id, target: to.target, x: tip.x, y: tip.y }
					: { stroke: null, target: tip.selector || "", text: (tip.text || "").replace(/\s+/g, " ").trim().slice(0, 80), x: tip.x, y: tip.y },
			});
		}
	}
	return relations;
}

export function describeRelation(r) {
	const at = `(${Math.round(r.to.x)}, ${Math.round(r.to.y)})`;
	if (r.kind === "move") return `ARROW: MOVE ${r.from.target || "MARKED AREA"} → ${at}${r.to.target ? " ON " + r.to.target : ""}`;
	if (r.kind === "link") return `ARROW: ${r.from.target || "MARK"} → ${r.to.target || "MARK"}`;
	return `ARROW: POINTS AT ${r.to.target || "MARK"}`;
}
