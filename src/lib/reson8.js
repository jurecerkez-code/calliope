// Reson8 realtime client and message adapter.
//
// Verified against docs.reson8.dev (API reference: /api/speech-to-text/realtime,
// auth: /authentication, token: /api/auth/token) on 2026-10-24:
// - Endpoint: wss://api.reson8.dev/v1/speech-to-text/realtime
// - Browsers cannot set headers, so the short-lived access token goes in the
//   sub-protocol: new WebSocket(url, ['bearer', token]). The API key itself is never
//   sent from the panel; background.js exchanges it at POST /v1/auth/token.
// - Audio: binary frames. We send raw PCM, so encoding=pcm_s16le&sample_rate=16000&channels=1.
// - Transcript frames: { type: 'transcript', text, is_final, start_ms, duration_ms,
//   words: [{ text, start_ms, duration_ms }] }. `is_final` only appears with
//   include_interim=true; the timing fields only with include_timestamps=true.
// - Flush: send { type: 'flush_request' }, server answers { type: 'flush_confirmation', id }.
// - Close codes: 1000 normal, 1011 internal_error / internal_timeout, 4000 message_backlog,
//   1006 network drop. Upgrade rejections (401/402/429) surface in the browser only as 1006.
//
// The first few raw frames are logged to the console ("[reson8 raw]") so field names can
// be checked against a live stream.

export const REALTIME_URL = "wss://api.reson8.dev/v1/speech-to-text/realtime";
export const SAMPLE_RATE = 16000;
const RAW_LOG_LIMIT = 5;

export function buildUrl({ language } = {}) {
	const params = new URLSearchParams({
		encoding: "pcm_s16le",
		sample_rate: String(SAMPLE_RATE),
		channels: "1",
		include_timestamps: "true",
		include_words: "true",
		include_interim: "true",
	});
	if (language) params.set("language", language);
	return `${REALTIME_URL}?${params}`;
}

// Maps a Reson8 transcript frame onto session time.
// audioStartMs is the session time when the first audio frame was sent. Reson8 times are
// relative to the start of the audio stream, so session = audioStartMs + start_ms.
// This is an approximation: it ignores capture and network latency before the first frame.
export function adaptMessage(msg, audioStartMs) {
	if (!msg || msg.type !== "transcript") return null;
	const base = audioStartMs ?? 0;
	const words = (msg.words || []).map((w) => ({
		text: w.text,
		startMs: Math.round(base + (w.start_ms ?? 0)),
		endMs: Math.round(base + (w.start_ms ?? 0) + (w.duration_ms ?? 0)),
	}));
	const startMs =
		msg.start_ms != null ? base + msg.start_ms : (words[0]?.startMs ?? base);
	const endMs =
		msg.start_ms != null && msg.duration_ms != null
			? base + msg.start_ms + msg.duration_ms
			: (words[words.length - 1]?.endMs ?? startMs);
	return {
		text: (msg.text || "").trim(),
		// Without include_interim the server sends only finals and omits the flag.
		final: msg.is_final ?? true,
		startMs: Math.round(startMs),
		endMs: Math.round(endMs),
		words,
	};
}

export function describeClose(code, reason) {
	if (code === 1000) return null;
	if (code === 4000)
		return "Reson8 closed the stream: messages were not read fast enough (message_backlog).";
	if (code === 1011)
		return `Reson8 server error (${reason || "internal_error"}). Try again.`;
	if (code === 1006) {
		return "Connection to Reson8 failed or dropped. Check your network, your API key, your credit (402) and concurrent session limit (429).";
	}
	return `Reson8 closed the connection (code ${code}${reason ? `, ${reason}` : ""}).`;
}

export class Reson8Client {
	constructor({ onTranscript, onStatus, onError }) {
		this.onTranscript = onTranscript;
		this.onStatus = onStatus || (() => {});
		this.onError = onError || (() => {});
		this.ws = null;
		this.rawLogged = 0;
		this.closedByUs = false;
	}

	connect(token, { language } = {}) {
		return new Promise((resolve, reject) => {
			this.closedByUs = false;
			const ws = new WebSocket(buildUrl({ language }), ["bearer", token]);
			ws.binaryType = "arraybuffer";
			this.ws = ws;
			let opened = false;
			ws.onopen = () => {
				opened = true;
				this.onStatus("open");
				resolve();
			};
			ws.onmessage = (ev) => {
				if (typeof ev.data !== "string") return;
				if (this.rawLogged < RAW_LOG_LIMIT) {
					this.rawLogged++;
					console.log("[reson8 raw]", ev.data);
				}
				let msg;
				try {
					msg = JSON.parse(ev.data);
				} catch {
					return;
				}
				if (msg.type === "transcript") this.onTranscript(msg);
				else if (msg.type === "flush_confirmation") this.onStatus("flushed");
			};
			ws.onclose = (ev) => {
				this.ws = null;
				this.onStatus("closed");
				const problem = this.closedByUs
					? null
					: describeClose(ev.code, ev.reason);
				if (!opened)
					reject(new Error(problem || "Could not connect to Reson8."));
				else if (problem) this.onError(problem);
			};
		});
	}

	get open() {
		return this.ws?.readyState === WebSocket.OPEN;
	}

	sendAudio(buffer) {
		if (this.open) this.ws.send(buffer);
	}

	flush() {
		if (this.open) this.ws.send(JSON.stringify({ type: "flush_request" }));
	}

	// Flush first so the last words arrive, then close after a short grace period.
	close({ graceMs = 1200 } = {}) {
		const ws = this.ws;
		if (!ws) return;
		this.closedByUs = true;
		this.flush();
		setTimeout(() => ws.close(1000), graceMs);
	}
}
