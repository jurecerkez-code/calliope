// Stroke geometry: simplification, bounding box, and rendering.
import { recognizeShape } from "../shape-recognition.js";
// Points are { x, y, t } in page CSS pixels; t is session time in ms.
// No DOM or chrome.* access here, so it runs in the page, the panel, and Node tests.

// Shared by the overlay and the PNG export so marks look the same in both.
export const STROKE_COLORS = [
	"#e5484d",
	"#0090ff",
	"#30a46c",
	"#f76b15",
	"#8e4ec6",
	"#d6409f",
];
export const strokeColor = (id) =>
	STROKE_COLORS[
		(parseInt(String(id).replace(/\D/g, ""), 10) - 1) % STROKE_COLORS.length
	] || STROKE_COLORS[0];

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function perpDistance(p, a, b) {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const len = Math.hypot(dx, dy);
	if (len === 0) return dist(p, a);
	return Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / len;
}

// Ramer-Douglas-Peucker. Iterative so long strokes cannot blow the stack.
export function simplify(points, epsilon = 1.5) {
	if (points.length <= 2) return points.slice();
	const keep = new Uint8Array(points.length);
	keep[0] = keep[points.length - 1] = 1;
	const stack = [[0, points.length - 1]];
	while (stack.length) {
		const [start, end] = stack.pop();
		let maxD = 0;
		let index = -1;
		for (let i = start + 1; i < end; i++) {
			const d = perpDistance(points[i], points[start], points[end]);
			if (d > maxD) {
				maxD = d;
				index = i;
			}
		}
		if (maxD > epsilon && index !== -1) {
			keep[index] = 1;
			stack.push([start, index], [index, end]);
		}
	}
	return points.filter((_, i) => keep[i]);
}

export function bboxOf(points) {
	let minX = Infinity,
		minY = Infinity,
		maxX = -Infinity,
		maxY = -Infinity;
	for (const p of points) {
		if (p.x < minX) minX = p.x;
		if (p.y < minY) minY = p.y;
		if (p.x > maxX) maxX = p.x;
		if (p.y > maxY) maxY = p.y;
	}
	return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function pathLength(points) {
	let len = 0;
	for (let i = 1; i < points.length; i++) len += dist(points[i - 1], points[i]);
	return len;
}

// Counts sharp direction reversals; a scribble has many.
function reversals(points) {
	let count = 0;
	for (let i = 2; i < points.length; i++) {
		const a = points[i - 2],
			b = points[i - 1],
			c = points[i];
		const v1x = b.x - a.x,
			v1y = b.y - a.y,
			v2x = c.x - b.x,
			v2y = c.y - b.y;
		const m = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
		if (m > 0 && (v1x * v2x + v1y * v2y) / m < -0.5) count++;
	}
	return count;
}

// Returns "dot" | "closed-loop" | "underline" | "line" | "scribble".
// Thresholds are tuned by hand for mouse and trackpad input at 1x zoom.
export function classifyShape(points) {
	if (points.length === 0) return "dot";
	const box = bboxOf(points);
	const diag = Math.hypot(box.w, box.h);
	const len = pathLength(points);
	if (diag < 12 || len < 15) return "dot";

	const first = points[0];
	const last = points[points.length - 1];
	const gap = dist(first, last);
	const straightness = gap / len;
	const simple = simplify(points, 4);

	if (reversals(simple) >= 3 && straightness < 0.5) return "scribble";
	if (gap < Math.max(25, diag * 0.25) && len > diag * 1.6) return "closed-loop";
	if (straightness > 0.8) {
		const horizontal = box.h <= Math.max(14, box.w * 0.15);
		return horizontal && box.w >= 30 ? "underline" : "line";
	}
	// Open curves that nearly close (a "C" around something) still read as loops.
	if (len > diag * 2) return "closed-loop";
	return straightness > 0.55 ? "line" : "scribble";
}

// Key point an agent should look at: the end of a line (arrow head), otherwise the box centre.
export function anchorOf(shape, points, box) {
	if (shape === "line" && points.length) {
		const end = points[points.length - 1];
		return { x: Math.round(end.x), y: Math.round(end.y) };
	}
	return { x: Math.round(box.x + box.w / 2), y: Math.round(box.y + box.h / 2) };
}

// Builds the stroke record shared by overlay, panel, and packet.
export function makeStroke(id, rawPoints) {
	const points = simplify(rawPoints);
	const box = bboxOf(rawPoints);
	const shape = recognizeShape(rawPoints).shape;
	const round = (n) => Math.round(n * 10) / 10;
	return {
		id,
		startMs: Math.round(rawPoints[0].t),
		endMs: Math.round(rawPoints[rawPoints.length - 1].t),
		shape,
		bbox: {
			x: round(box.x),
			y: round(box.y),
			w: round(box.w),
			h: round(box.h),
		},
		anchor: anchorOf(shape, rawPoints, box),
		points: points.map((p) => ({
			x: round(p.x),
			y: round(p.y),
			t: Math.round(p.t),
		})),
		targets: [],
	};
}

// Paints a stroke and its id badge on a 2D canvas context. `toCanvas` maps a page point
// to canvas pixels; `scale` multiplies line widths (devicePixelRatio).
export function paintStroke(ctx, stroke, toCanvas, scale = 1, { highlight = false } = {}) {
  const pts = stroke.points;
  if (!pts.length) return;
  const color = strokeColor(stroke.id);
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = color;
  ctx.lineWidth = (highlight ? 6 : 3.5) * scale;
  ctx.beginPath();
  const p0 = toCanvas(pts[0]);
  ctx.moveTo(p0.x, p0.y);
  if (pts.length === 1) {
    ctx.arc(p0.x, p0.y, 4 * scale, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }
  for (let i = 1; i < pts.length; i++) {
    const a = toCanvas(pts[i - 1]);
    const b = toCanvas(pts[i]);
    ctx.quadraticCurveTo(a.x, a.y, (a.x + b.x) / 2, (a.y + b.y) / 2);
  }
  if (pts.length > 1) {
    const end = toCanvas(pts[pts.length - 1]);
    ctx.lineTo(end.x, end.y);
  }
  ctx.stroke();

  if (stroke.id) {
    const r = 10 * scale;
    const bx = p0.x - r * 1.2;
    const by = p0.y - r * 1.2;
    ctx.beginPath();
    ctx.arc(bx, by, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = `600 ${11 * scale}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(stroke.id, bx, by + 0.5 * scale);
  }
  ctx.restore();
}
