import * as lyric from "@applemusic-like-lyrics/lyric";
import * as amllStates from "@applemusic-like-lyrics/react-full";
import * as http from "@tauri-apps/plugin-http";
import { useAtomValue, useSetAtom, useStore } from "jotai";
import { type FC, useCallback, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import * as appAtoms from "../../states/appAtoms";
import { extensionMetaAtom } from "../../states/extension.ts";
import * as extensionsAtoms from "../../states/extensionsAtoms";
import type {
	ExtensionMetaState,
	LoadedExtension,
} from "../../states/extensionsAtoms.ts";
import { ExtensionLoadResult } from "../../states/extensionsAtoms.ts";
import { db } from "../../utils/db-client.ts";
import { PlayerExtensionContext } from "./ext-ctx.ts";
import { EXTENSION_LOG_TAG, runExtensionScript } from "./runtime.ts";

class Notify {
	promise: Promise<void>;
	resolve: () => void;
	reject: (err: Error) => void;
	constructor() {
		let resolve: () => void = () => {};
		let reject: (err: Error) => void = () => {};
		const p = new Promise<void>((res, rej) => {
			resolve = res;
			reject = rej;
		});
		this.promise = p;
		this.resolve = resolve;
		this.reject = reject;
	}

	wait() {
		return this.promise;
	}

	notify() {
		this.resolve();
	}
}

async function closeExtensionWindows(
	context: PlayerExtensionContext,
	extensionId: string,
) {
	try {
		await context.dispose();
	} catch (err) {
		console.warn(EXTENSION_LOG_TAG, "关闭扩展程序窗口失败", extensionId, err);
		context.deactivate();
	}
}

const SingleExtensionContext: FC<{
	extensionMeta: ExtensionMetaState;
	waitForDependency: (extensionId: string) => Promise<void>;
	extPromise: readonly [Promise<void>, () => void, (err: Error) => void];
}> = ({ extensionMeta, waitForDependency, extPromise }) => {
	const store = useStore();
	const { i18n } = useTranslation();
	const cancelRef = useRef<Notify | undefined>(undefined);
	const setLoadedExtension = useSetAtom(extensionsAtoms.loadedExtensionAtom);
	useEffect(() => {
		let canceled = false;
		const extI18n = i18n.cloneInstance({
			ns: extensionMeta.id,
		});

		const playerStatesObject = Object.freeze({
			...appAtoms,
			...extensionsAtoms,
		});

		const context = new PlayerExtensionContext(
			playerStatesObject,
			Object.freeze({ ...amllStates }),
			extI18n,
			store,
			extensionMeta,
			lyric,
			db,
			http,
		);

		const loadedExt: LoadedExtension = {
			extensionFunc: async () => {},
			extensionMeta,
			context,
		};

		(async () => {
			const cancelNotify = cancelRef.current;
			if (cancelNotify) {
				await cancelNotify.wait();
			}
			if (canceled) return;
			console.log(
				EXTENSION_LOG_TAG,
				"正在加载扩展程序",
				extensionMeta.id,
				extensionMeta.fileName,
			);
			await runExtensionScript({
				extensionMeta,
				context,
				waitForDependency,
				resolveExtensionLoad: extPromise[1],
				rejectExtensionLoad: extPromise[2],
				isCanceled: () => canceled,
			});
			if (canceled) return;
			context.dispatchEvent(new Event("extension-load"));

			console.log(
				EXTENSION_LOG_TAG,
				"扩展程序",
				extensionMeta.id,
				extensionMeta.fileName,
				"加载完成",
			);
			setLoadedExtension((v) => [...v, loadedExt]);
		})();
		return () => {
			canceled = true;
			const notify = new Notify();
			cancelRef.current = notify;
			(async () => {
				context.dispatchEvent(new Event("extension-unload"));
				await closeExtensionWindows(context, extensionMeta.id);
				setLoadedExtension((v) => v.filter((e) => e !== loadedExt));
				notify.notify();
			})();
		};
	}, [
		extensionMeta,
		i18n,
		store,
		waitForDependency,
		setLoadedExtension,
		extPromise,
	]);

	return null;
};

export const ExtensionContext: FC = () => {
	const extensionMeta = useAtomValue(extensionMetaAtom);

	const loadableExtensions = useMemo(
		() =>
			extensionMeta.filter(
				(v: ExtensionMetaState) =>
					v.loadResult === ExtensionLoadResult.Loadable,
			),
		[extensionMeta],
	);

	type PromiseTuple = readonly [
		Promise<void>,
		() => void,
		(err: Error) => void,
	];

	const loadingPromisesMap = useMemo(
		() =>
			new Map<string, PromiseTuple>(
				loadableExtensions.map((state: ExtensionMetaState) => {
					let resolve: () => void = () => {};
					let reject: (err: Error) => void = () => {};
					const p = new Promise<void>((res, rej) => {
						resolve = res;
						reject = rej;
					});
					return [state.id, [p, resolve, reject] as const] as const;
				}),
			),
		[loadableExtensions],
	);

	const waitForDependency = useCallback(
		async (extensionId: string) => {
			const promise = loadingPromisesMap.get(extensionId);
			if (promise) {
				await promise[0];
			} else {
				throw new Error(`Missing Dependency: ${extensionId}`);
			}
		},
		[loadingPromisesMap],
	);

	return loadableExtensions.map((metaState: ExtensionMetaState) => {
		const extPromise = loadingPromisesMap.get(metaState.id);

		if (!extPromise) {
			return null;
		}

		return (
			<SingleExtensionContext
				key={`${metaState.fileName}-${metaState.id}`}
				extensionMeta={metaState}
				waitForDependency={waitForDependency}
				extPromise={extPromise}
			/>
		);
	});
};

export default ExtensionContext;
