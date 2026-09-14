export interface VideoDrawRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Match the centered object-fit used by the song's video layer. */
export function getVideoDrawRect(
	sourceWidth: number,
	sourceHeight: number,
	width: number,
	height: number,
	fit: string,
): VideoDrawRect | null {
	if (
		![sourceWidth, sourceHeight, width, height].every(
			(value) => Number.isFinite(value) && value > 0,
		)
	) {
		return null;
	}
	if (fit === "fill") return { x: 0, y: 0, width, height };
	const ratio =
		fit === "contain"
			? Math.min(width / sourceWidth, height / sourceHeight)
			: Math.max(width / sourceWidth, height / sourceHeight);
	const drawnWidth = sourceWidth * ratio;
	const drawnHeight = sourceHeight * ratio;
	return {
		x: (width - drawnWidth) / 2,
		y: (height - drawnHeight) / 2,
		width: drawnWidth,
		height: drawnHeight,
	};
}

export interface CanvasFrameSource {
	video: HTMLVideoElement;
	dispose: () => void;
}

/** Canvas streams retain rendered WebGL frames after its drawing buffer clears. */
export function createCanvasFrameSource(
	canvas: HTMLCanvasElement,
	fps: number,
): CanvasFrameSource {
	const stream = canvas.captureStream(fps);
	const video = document.createElement("video");
	video.muted = true;
	video.playsInline = true;
	video.srcObject = stream;
	let disposed = false;
	const dispose = () => {
		if (disposed) return;
		disposed = true;
		video.pause();
		video.srcObject = null;
		for (const track of stream.getTracks()) track.stop();
	};
	void video.play().catch(dispose);
	return { video, dispose };
}
