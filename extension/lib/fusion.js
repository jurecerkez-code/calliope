// Fusion: binds spoken deictic words to strokes by time, classifies intent, and builds
// the context packet. Pure functions over plain data, so they run in Node tests.

export const DEICTICS = new Set([
	"this",
	"that",
	"these",
	"those",
	"here",
	"there",
]);
const PLACE_WORDS = new Set(["here", "there"]);

// People usually point slightly before or while they say "this", so the window reaches
// further back than forward.
export const DEFAULT_WINDOW = { beforeMs: 6000, afterMs: 2500 };

const normalize = (w) => w.toLowerCase().replace(/[^a-z']/g, "");

// Time gap between a word and a stroke: 0 when the word falls inside the stroke,
// positive otherwise. Returns Infinity when outside the window.
function gap(atMs, stroke, win) {
	if (atMs >= stroke.startMs && atMs <= stroke.endMs) return 0;
	if (stroke.endMs < atMs) {
		const d = atMs - stroke.endMs;
		return d <= win.beforeMs ? d : Infinity;
	}
	const d = stroke.startMs - atMs;
	return d <= win.afterMs ? d : Infinity;
}

function bindingConfidence(d, win) {
	return (
		Math.round(
			(1 - 0.5 * Math.min(1, d / Math.max(win.beforeMs, win.afterMs))) * 100,
		) / 100
	);
}

// Returns [{ word, atMs, strokeId, confidence }] for one utterance.
// Within an utterance, a second deictic prefers a stroke not yet used ("move this here").
export function bindReferences(utterance, strokes, win = DEFAULT_WINDOW) {
	const refs = [];
	const used = new Set();
	for (const w of utterance.words || []) {
		const word = normalize(w.text);
		if (!DEICTICS.has(word)) continue;
		const atMs = Math.round((w.startMs + w.endMs) / 2);
		const candidates = strokes
			.map((s) => ({ s, d: gap(atMs, s, win) }))
			.filter((c) => c.d !== Infinity)
			.sort((a, b) => a.d - b.d);
		if (!candidates.length) {
			refs.push({ word, atMs, strokeId: null, confidence: 0 });
			continue;
		}
		const pick = candidates.find((c) => !used.has(c.s.id)) || candidates[0];
		used.add(pick.s.id);
		refs.push({
			word,
			atMs,
			strokeId: pick.s.id,
			confidence: bindingConfidence(pick.d, win),
		});
	}
	return refs;
}

// No deictic word: fall back to the stroke closest in time to the utterance itself.
function implicitReference(utterance, strokes, win) {
	let best = null;
	for (const s of strokes) {
		const overlap =
			s.endMs >= utterance.startMs && s.startMs <= utterance.endMs;
		const d = overlap
			? 0
			: Math.min(gap(utterance.startMs, s, win), gap(utterance.endMs, s, win));
		if (d !== Infinity && (!best || d < best.d)) best = { s, d };
	}
	if (!best) return null;
	return {
		word: null,
		atMs: utterance.startMs,
		strokeId: best.s.id,
		confidence: Math.round(bindingConfidence(best.d, win) * 0.7 * 100) / 100,
		implicit: true,
	};
}

const INTENT_RULES = [
	[
		"query",
		/^(what|why|how|which|where|who|is|are|does|do|can|could)\b|\?\s*$/,
	],
	[
		"remove",
		/\b(remove|delete|get rid of|hide|drop|take (?:out|away)|kill|eliminate)\b/,
	],
	[
		"move",
		/\b(move|shift|drag|swap|reorder|relocate)\b|\b(?:put|place) (?:this|that|these|those|it|the(?! new\b))\b/,
	],
	[
		"add",
		/\b(add|insert|create|append|include)\b|\b(?:put|place) (?:a|an|another|some|new)\b|\bnew\b/,
	],
	[
		"modify",
		/\b(should be|make|change|turn|set|rename|replace|resize|update|fix|bigger|smaller|larger|more|less|color|colour|bold|align|center|centre|wider|narrower|darker|lighter)\b/,
	],
];

export function classifyIntent(text) {
	const t = text.toLowerCase().trim();
	for (const [intent, re] of INTENT_RULES) if (re.test(t)) return intent;
	return "unknown";
}

function strokeById(strokes, id) {
	return strokes.find((s) => s.id === id);
}

// The reference whose stroke an agent should act on. For add/move, the place word
// ("here") marks where; otherwise the object word ("this") marks what.
function primaryReference(intent, refs) {
	const bound = refs.filter((r) => r.strokeId);
	if (!bound.length) return null;
	if (intent === "add")
		return bound.find((r) => PLACE_WORDS.has(r.word)) || bound[0];
	return bound.find((r) => !PLACE_WORDS.has(r.word)) || bound[0];
}

const fmtTarget = (t) =>
	t ? `${t.tag} "${t.label}" (${t.selector})` : "the marked area";

function instructionFor(intent, utterance, target, refs, strokes) {
	const verb =
		intent === "unknown" ? "Change" : intent[0].toUpperCase() + intent.slice(1);
	let where = fmtTarget(target);
	if (intent === "add" && target?.anchor)
		where = `at page (${target.anchor.x}, ${target.anchor.y}), inside ${fmtTarget(target)}`;
	if (intent === "move") {
		const dest = refs.find((r) => PLACE_WORDS.has(r.word) && r.strokeId);
		const destStroke = dest && strokeById(strokes, dest.strokeId);
		if (destStroke)
			where += ` to page (${destStroke.anchor.x}, ${destStroke.anchor.y}) (stroke ${destStroke.id})`;
	}
	if (intent === "query") return `Answer about ${where}: "${utterance.text}"`;
	return `${verb} ${where}: "${utterance.text}"`;
}

// Resolves every final utterance against the strokes.
export function fuse(utterances, strokes, win = DEFAULT_WINDOW) {
	return utterances.map((u) => {
		const intent = classifyIntent(u.text);
		let references = bindReferences(u, strokes, win);
		if (!references.some((r) => r.strokeId)) {
			const implicit = implicitReference(u, strokes, win);
			if (implicit) references = [...references, implicit];
		}
		const primary = primaryReference(intent, references);
		const stroke = primary && strokeById(strokes, primary.strokeId);
		const top = stroke?.targets?.[0];
		const target = top
			? {
					...top,
					confidence:
						Math.round(top.confidence * primary.confidence * 100) / 100,
					strokeId: stroke.id,
					anchor: stroke.anchor,
				}
			: stroke
				? {
						selector: "",
						label: "",
						tag: "",
						confidence: 0,
						strokeId: stroke.id,
						anchor: stroke.anchor,
					}
				: null;
		return {
			...u,
			intent,
			references,
			target,
			instruction: instructionFor(intent, u, target, references, strokes),
		};
	});
}

export function buildTimeline(strokes, fused) {
	const items = [];
	for (const s of strokes) {
		const t = s.targets?.[0];
		items.push({
			startMs: s.startMs,
			endMs: s.endMs,
			type: "drawing",
			id: s.id,
			label: `${s.id} ${s.shape}${t ? ` on ${t.tag} "${t.label}"` : ""}`,
		});
	}
	let r = 0;
	for (const u of fused) {
		items.push({
			startMs: u.startMs,
			endMs: u.endMs,
			type: "speech",
			id: u.id,
			label: u.text,
		});
		for (const ref of u.references) {
			r++;
			items.push({
				startMs: ref.atMs,
				endMs: ref.atMs,
				type: "reference",
				id: `R${r}`,
				label: `${ref.word ? `"${ref.word}"` : "(implicit)"} -> ${ref.strokeId || "unbound"}`,
			});
		}
	}
	return items.sort(
		(a, b) => a.startMs - b.startMs || a.type.localeCompare(b.type),
	);
}

// Packet shape follows the brief. Additions beyond it: stroke.anchor, target.strokeId,
// target.anchor, reference.confidence, reference.implicit, session.baseChanges.
export function buildPacket({
	elapsedMs,
	base,
	baseChanges = [],
	page,
	strokes,
	utterances,
	window: win = DEFAULT_WINDOW,
}) {
	const finals = utterances.filter((u) => u.final && u.text);
	const fused = fuse(finals, strokes, win);
	return {
		session: {
			elapsedMs: Math.round(elapsedMs),
			base,
			baseChanges,
			...(page ? { page } : {}),
		},
		timeline: buildTimeline(strokes, fused),
		strokes: strokes.map((s) => ({
			id: s.id,
			startMs: s.startMs,
			endMs: s.endMs,
			shape: s.shape,
			bbox: s.bbox,
			anchor: s.anchor,
			targets: s.targets,
		})),
		utterances: fused.map((u) => ({
			id: u.id,
			startMs: u.startMs,
			endMs: u.endMs,
			text: u.text,
			final: u.final,
			source: u.source,
			intent: u.intent,
			references: u.references,
			target: u.target,
			instruction: u.instruction,
		})),
	};
}

export function packetText(packet) {
	const n = packet.utterances.length;
	return [
		`Draw and Talk context packet: ${packet.strokes.length} stroke(s), ${n} utterance(s). Times are ms from session start; coordinates are page CSS pixels.`,
		"```json",
		JSON.stringify(packet, null, 2),
		"```",
		"Paste the PNG snapshot alongside this. Its numbered badges (S1, S2, ...) match strokes[].id.",
	].join("\n");
}

// Simulated speech: spreads typed words evenly over [startMs, endMs] so they look like
// a Reson8 transcript with word timestamps.
export function simulateWords(text, startMs, endMs) {
	const tokens = text.trim().split(/\s+/).filter(Boolean);
	if (!tokens.length) return [];
	const span = Math.max(1, endMs - startMs) / tokens.length;
	return tokens.map((t, i) => ({
		text: t,
		startMs: Math.round(startMs + i * span),
		endMs: Math.round(startMs + i * span + span * 0.9),
	}));
}

// Typical speaking rate, used when there is no typing interval to go on.
export const MS_PER_WORD = 380;
