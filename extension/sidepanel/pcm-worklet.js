// AudioWorklet: converts mono float input to 16-bit little-endian PCM and posts
// ~100 ms chunks to the panel. The AudioContext runs at 16 kHz, so no resampling here.
class PcmCapture extends AudioWorkletProcessor {
	constructor() {
		super();
		this.chunk = new Int16Array(1600);
		this.fill = 0;
	}

	process(inputs) {
		const input = inputs[0] && inputs[0][0];
		if (!input) return true;
		for (let i = 0; i < input.length; i++) {
			const s = Math.max(-1, Math.min(1, input[i]));
			this.chunk[this.fill++] = s < 0 ? s * 0x8000 : s * 0x7fff;
			if (this.fill === this.chunk.length) {
				this.port.postMessage(this.chunk.buffer, [this.chunk.buffer]);
				this.chunk = new Int16Array(1600);
				this.fill = 0;
			}
		}
		return true;
	}
}

registerProcessor("pcm-capture", PcmCapture);
