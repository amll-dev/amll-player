import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const readRuntime = (extension) =>
	readFileSync(
		new URL(
			`../node_modules/@applemusic-like-lyrics/react-full/dist/amll-react-framework.${extension}`,
			import.meta.url,
		),
		"utf8",
	);
const extractHook = (source) => {
	const start = source.indexOf("function useDecodedCoverUrl(");
	const end = source.indexOf("\nconst Cover =", start);
	assert.ok(
		start >= 0 && end > start,
		"installed Cover must contain the readiness hook",
	);
	return source.slice(start, end);
};

// Execute the installed async hook with controllable load/decode completion.
// Browser verification separately covers React commits and CSS cross-fades.
function createHarness(extension) {
	let state;
	let initialized = false;
	let dependencies;
	let cleanup;
	const images = [];
	const react = {
		useState(initial) {
			if (!initialized) {
				state = initial;
				initialized = true;
			}
			return [
				state,
				(value) => {
					state = value;
				},
			];
		},
		useLayoutEffect(effect, next) {
			if (!dependencies || next.some((value, i) => value !== dependencies[i])) {
				cleanup?.();
				dependencies = next;
				cleanup = effect();
			}
		},
	};
	class TestImage {
		src = "";
		naturalWidth = 400;
		onload = null;
		onerror = null;
		decode = () => Promise.resolve();
		constructor() {
			images.push(this);
		}
	}
	const hook = runInNewContext(`(${extractHook(readRuntime(extension))})`, {
		...react,
		react,
		Image: TestImage,
	});
	return {
		images,
		render: (url, video = false) => hook(url, video),
		get current() {
			return state;
		},
		unmount: () => cleanup?.(),
	};
}

for (const extension of ["mjs", "cjs"]) {
	test(`${extension}: a replacement stays hidden until decoding finishes`, async () => {
		const h = createHarness(extension);
		h.render("A");
		assert.equal(h.render("B"), "A");
		const image = h.images.at(-1);
		let finishDecode;
		image.decode = () =>
			new Promise((resolve) => {
				finishDecode = resolve;
			});
		const loading = image.onload();
		assert.equal(h.current, "A");
		finishDecode();
		await loading;
		assert.equal(h.current, "B");
	});

	test(`${extension}: an older decode cannot overwrite the latest song`, async () => {
		const h = createHarness(extension);
		h.render("A");
		h.render("B");
		const oldImage = h.images.at(-1);
		let finishDecode;
		oldImage.decode = () =>
			new Promise((resolve) => {
				finishDecode = resolve;
			});
		const oldLoading = oldImage.onload();
		h.render("C");
		await h.images.at(-1).onload();
		finishDecode();
		await oldLoading;
		assert.equal(h.current, "C");
		assert.equal(oldImage.src, "");
		assert.equal(oldImage.onload, null);
	});

	test(`${extension}: unmount invalidates pending decode completion`, async () => {
		const h = createHarness(extension);
		h.render("A");
		h.render("B");
		let finishDecode;
		h.images.at(-1).decode = () =>
			new Promise((resolve) => {
				finishDecode = resolve;
			});
		const loading = h.images.at(-1).onload();
		h.unmount();
		finishDecode();
		await loading;
		assert.equal(h.current, "A");
	});

	test(`${extension}: usable images survive decode rejection without CORS opt-in`, async () => {
		const h = createHarness(extension);
		h.render("A");
		h.render("https://example.invalid/cover");
		const image = h.images.at(-1);
		assert.equal(image.crossOrigin, undefined);
		image.decode = () => Promise.reject(new Error("decode unavailable"));
		await image.onload();
		assert.equal(h.current, "https://example.invalid/cover");
	});

	test(`${extension}: errors and empty covers clear stale artwork, then recover`, async () => {
		const h = createHarness(extension);
		h.render("A");
		h.render("broken");
		h.images.at(-1).onerror();
		assert.equal(h.current, "");
		h.render("C");
		await h.images.at(-1).onload();
		assert.equal(h.current, "C");
		h.render("");
		assert.equal(h.current, "");
	});

	test(`${extension}: video bypasses image loading and cancels a pending image`, async () => {
		const h = createHarness(extension);
		h.render("A");
		h.render("B");
		const image = h.images.at(-1);
		const oldLoad = image.onload;
		assert.equal(h.render("movie.webm", true), "movie.webm");
		assert.equal(h.images.length, 2);
		await oldLoad();
		assert.equal(h.current, "");
		h.render("C");
		await h.images.at(-1).onload();
		assert.equal(h.current, "C");
	});
}
