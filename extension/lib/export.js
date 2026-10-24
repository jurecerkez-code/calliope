// Export: renders the marks over the base image as a PNG, and handles clipboard/download.
import { paintStroke } from "./strokes.js";

// shot: { dataUrl, scrollX, scrollY, width, height } where width/height are the CSS
// viewport size at capture time. captureVisibleTab only returns the visible area, so
// strokes outside it are clipped; their ids are returned so the UI can say so.
export async function renderPng(shot, strokes) {
	const bitmap = await createImageBitmap(
		await (await fetch(shot.dataUrl)).blob(),
	);
	const scale = bitmap.width / shot.width;
	const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
	const ctx = canvas.getContext("2d");
	ctx.drawImage(bitmap, 0, 0);
	const toCanvas = (p) => ({
		x: (p.x - shot.scrollX) * scale,
		y: (p.y - shot.scrollY) * scale,
	});
	const clipped = [];
	for (const s of strokes) {
		const b = s.bbox;
		const visible =
			b.x + b.w >= shot.scrollX &&
			b.x <= shot.scrollX + shot.width &&
			b.y + b.h >= shot.scrollY &&
			b.y <= shot.scrollY + shot.height;
		if (!visible) clipped.push(s.id);
		paintStroke(ctx, s, toCanvas, scale);
	}
	const blob = await canvas.convertToBlob({ type: "image/png" });
	return { blob, clipped };
}

export async function copyText(text) {
	await navigator.clipboard.writeText(text);
}

// Throws when the browser refuses image clipboard writes; callers fall back to download.
export async function copyPng(blob) {
	if (typeof ClipboardItem === "undefined")
		throw new Error("ClipboardItem is not supported");
	await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}

export function downloadBlob(blob, filename) {
	const url = URL.createObjectURL(blob);
	const a = Object.assign(document.createElement("a"), {
		href: url,
		download: filename,
	});
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
