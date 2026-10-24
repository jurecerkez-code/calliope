// Human ink. Every raw point is kept: no smoothing, no simplification, no snapping to
// a recognised shape. Only the width varies, thinner where the hand moved fast and
// tapering at both ends, so an arrow keeps its flick and a scribble stays a scribble.
export const INK = {
	pen: { color: "#FE2A00", width: 3.4 },
	highlighter: { color: "#D69E2E", width: 18, opacity: 0.38 },
};

export function inkOutline(pts, base = INK.pen.width) {
	const n = pts.length;
	if (!n) return "";
	if (n < 3) {
		const p = pts[0],
			r = base * 0.55;
		return `M ${p.x - r} ${p.y} a ${r} ${r} 0 1 0 ${2 * r} 0 a ${r} ${r} 0 1 0 ${-2 * r} 0`;
	}
	const left = [],
		right = [];
	for (let i = 0; i < n; i++) {
		const a = pts[Math.max(0, i - 1)],
			b = pts[Math.min(n - 1, i + 1)];
		const dx = b.x - a.x,
			dy = b.y - a.y,
			len = Math.hypot(dx, dy) || 1;
		// px per sample: a lingering pen pools ink, a fast one thins out
		const speed = len / 2;
		let w = base * (1.25 - Math.min(0.62, speed / 26));
		const head = Math.min(1, (i + 1) / 4),
			tail = Math.min(1, (n - i) / 8);
		w *= 0.32 + 0.68 * Math.min(head, tail);
		w *= 1 + 0.1 * Math.sin(i * 2.399); // nib grain, deterministic
		const nx = ((-dy / len) * w) / 2,
			ny = ((dx / len) * w) / 2;
		left.push(`${(pts[i].x + nx).toFixed(1)} ${(pts[i].y + ny).toFixed(1)}`);
		right.push(`${(pts[i].x - nx).toFixed(1)} ${(pts[i].y - ny).toFixed(1)}`);
	}
	return "M " + left.join(" L ") + " L " + right.reverse().join(" L ") + " Z";
}

export const polyline = (pts) =>
	"M " + pts.map((p) => `${Math.round(p.x)} ${Math.round(p.y)}`).join(" L ");
