import assert from "node:assert/strict";
import test from "node:test";

globalThis.window = globalThis;

const { clearMocks, mockIPC } = await import("@tauri-apps/api/mocks");

let moduleSequence = 0;

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((promiseResolve, promiseReject) => {
		resolve = promiseResolve;
		reject = promiseReject;
	});
	return { promise, reject, resolve };
}

async function loadFreshPlayer() {
	moduleSequence += 1;
	return import(
		`../src/utils/player.ts?audio-thread-initialization=${moduleSequence}`
	);
}

test("事件监听完成前 emitAudioThread 不会向后端发送消息", {
	concurrency: false,
}, async (context) => {
	const listenerRegistration = deferred();
	const calls = [];
	mockIPC((command, payload) => {
		calls.push({ command, payload });
		if (command === "plugin:event|listen") {
			return listenerRegistration.promise;
		}
		if (command === "local_player_send_msg") {
			return undefined;
		}
		throw new Error(`Unexpected IPC command: ${command}`);
	});
	context.after(clearMocks);

	const { emitAudioThread } = await loadFreshPlayer();
	const sendPromise = emitAudioThread("pauseAudio");

	assert.deepEqual(
		calls.map(({ command }) => command),
		["plugin:event|listen"],
	);

	listenerRegistration.resolve(1);
	await sendPromise;

	assert.deepEqual(
		calls.map(({ command }) => command),
		["plugin:event|listen", "local_player_send_msg"],
	);
});

test("并发发送与返回值请求共用一次事件监听初始化", {
	concurrency: false,
}, async (context) => {
	const listenerRegistration = deferred();
	const calls = [];
	const responseFailure = new Error("mock response failure");
	mockIPC((command, payload) => {
		calls.push({ command, payload });
		if (command === "plugin:event|listen") {
			return listenerRegistration.promise;
		}
		if (command === "local_player_send_msg") {
			if (payload.msg.data.type === "resumeAudio") {
				throw responseFailure;
			}
			return undefined;
		}
		throw new Error(`Unexpected IPC command: ${command}`);
	});
	context.after(clearMocks);

	const { emitAudioThread, emitAudioThreadRet } = await loadFreshPlayer();
	const pausePromise = emitAudioThread("pauseAudio");
	const stopPromise = emitAudioThread("stopAudio");
	const responsePromise = emitAudioThreadRet("resumeAudio");
	const responseAssertion = assert.rejects(responsePromise, responseFailure);

	assert.equal(
		calls.filter(({ command }) => command === "plugin:event|listen").length,
		1,
	);
	assert.equal(
		calls.filter(({ command }) => command === "local_player_send_msg").length,
		0,
	);

	listenerRegistration.resolve(2);
	await Promise.all([pausePromise, stopPromise, responseAssertion]);

	assert.equal(
		calls.filter(({ command }) => command === "plugin:event|listen").length,
		1,
	);
	assert.deepEqual(
		calls
			.filter(({ command }) => command === "local_player_send_msg")
			.map(({ payload }) => payload.msg.data.type)
			.sort(),
		["pauseAudio", "resumeAudio", "stopAudio"],
	);
});

test("事件监听初始化失败后下一次发送会重新初始化", {
	concurrency: false,
}, async (context) => {
	const calls = [];
	const initializationFailure = new Error("mock listen failure");
	let registrationAttempts = 0;
	mockIPC((command, payload) => {
		calls.push({ command, payload });
		if (command === "plugin:event|listen") {
			registrationAttempts += 1;
			if (registrationAttempts === 1) {
				throw initializationFailure;
			}
			return registrationAttempts;
		}
		if (command === "local_player_send_msg") {
			return undefined;
		}
		throw new Error(`Unexpected IPC command: ${command}`);
	});
	context.after(clearMocks);

	const { emitAudioThread } = await loadFreshPlayer();

	await assert.rejects(emitAudioThread("pauseAudio"), initializationFailure);
	assert.equal(registrationAttempts, 1);
	assert.equal(
		calls.filter(({ command }) => command === "local_player_send_msg").length,
		0,
	);

	await emitAudioThread("pauseAudio");
	assert.equal(registrationAttempts, 2);
	assert.equal(
		calls.filter(({ command }) => command === "local_player_send_msg").length,
		1,
	);
});
