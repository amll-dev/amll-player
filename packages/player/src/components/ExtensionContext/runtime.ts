import chalk from "chalk";
import { fromObject, fromSource, removeComments } from "convert-source-map";
import { SourceMapConsumer, SourceMapGenerator } from "source-map-js";
import { uid } from "uid";
import type { ExtensionMetaState } from "../../states/extensionsAtoms.ts";
import type { PlayerExtensionContext } from "./ext-ctx.ts";

const AsyncFunction: FunctionConstructor = Object.getPrototypeOf(
	async () => {},
).constructor;

export const EXTENSION_LOG_TAG = chalk.bgHex("#00AAFF").hex("#FFFFFF")(
	" EXTENSION ",
);

export type ExtensionDependencyWaiter = (extensionId: string) => Promise<void>;

export interface RunExtensionScriptOptions {
	extensionMeta: ExtensionMetaState;
	context: PlayerExtensionContext;
	waitForDependency: ExtensionDependencyWaiter;
	resolveExtensionLoad?: () => void;
	rejectExtensionLoad?: (err: Error) => void;
	isCanceled?: () => boolean;
}

declare global {
	interface Window {
		React: typeof import("react");
		ReactDOM: typeof import("react-dom");
		Jotai: typeof import("jotai");
		RadixTheme: typeof import("@radix-ui/themes");
		JSXRuntime: typeof import("react/jsx-runtime");
	}
}

export async function exposeExtensionGlobals() {
	const [React, ReactDOM, Jotai, RadixTheme, JSXRuntime] = await Promise.all([
		import("react"),
		import("react-dom"),
		import("jotai"),
		import("@radix-ui/themes"),
		import("react/jsx-runtime"),
	]);
	window.React = React;
	window.ReactDOM = ReactDOM;
	window.Jotai = Jotai;
	window.RadixTheme = RadixTheme;
	window.JSXRuntime = JSXRuntime;
}

export async function sourceMapOffsetLines(
	code: string,
	sourceRoot: string,
	lineOffset: number,
): Promise<[string, string]> {
	const incomingSourceConv = fromSource(code);
	if (!incomingSourceConv) return [code, ""];
	const incomingSourceMap = incomingSourceConv.toObject();
	const consumer = await new SourceMapConsumer(incomingSourceMap);
	const generator = new SourceMapGenerator({
		file: incomingSourceMap.file,
		sourceRoot: sourceRoot,
	});
	consumer.eachMapping((m) => {
		// skip invalid (not-connected) mapping
		// refs: https://github.com/mozilla/source-map/blob/182f4459415de309667845af2b05716fcf9c59ad/lib/source-map-generator.js#L268-L275
		if (
			typeof m.originalLine === "number" &&
			0 < m.originalLine &&
			typeof m.originalColumn === "number" &&
			0 <= m.originalColumn &&
			m.source
		) {
			generator.addMapping({
				source:
					m.source &&
					`${location.origin}/extensions/${sourceRoot}/${m.source.replace(/^(\.*\/)+/, "")}`,
				name: m.name,
				original: { line: m.originalLine, column: m.originalColumn },
				generated: {
					line: m.generatedLine + lineOffset,
					column: m.generatedColumn,
				},
			});
		}
	});
	const outgoingSourceMap = JSON.parse(generator.toString());
	if (typeof incomingSourceMap.sourcesContent !== "undefined") {
		outgoingSourceMap.sourcesContent = incomingSourceMap.sourcesContent;
	}
	return [removeComments(code), fromObject(outgoingSourceMap).toComment()];
}

export async function runExtensionScript({
	extensionMeta,
	context,
	waitForDependency,
	resolveExtensionLoad = () => {},
	rejectExtensionLoad = (err) => {
		throw err;
	},
	isCanceled = () => false,
}: RunExtensionScriptOptions) {
	await exposeExtensionGlobals();
	if (isCanceled()) return;

	const genFuncName = () => `__amll_internal_${uid()}`;
	const resolveFuncName = genFuncName();
	const rejectFuncName = genFuncName();
	const waitForDependencyFuncName = genFuncName();
	const wrapperScript: string[] = [];
	wrapperScript.push('"use strict";');
	wrapperScript.push("try {");

	for (const dependencyId of extensionMeta.dependency) {
		wrapperScript.push(
			`await ${waitForDependencyFuncName}(${JSON.stringify(dependencyId)})`,
		);
	}

	let comment = "";
	const offsetLines = wrapperScript.length + 2;

	try {
		const [code, sourceMapComment] = await sourceMapOffsetLines(
			extensionMeta.scriptData,
			extensionMeta.id,
			offsetLines,
		);
		if (isCanceled()) return;
		wrapperScript.push(code);
		comment = sourceMapComment;
	} catch (err) {
		console.log(
			EXTENSION_LOG_TAG,
			"无法转换源映射表，可能是扩展程序并不包含源映射表",
			err,
		);
		wrapperScript.push(extensionMeta.scriptData);
	}

	wrapperScript.push(`${resolveFuncName}();`);
	wrapperScript.push("} catch (err) {");
	wrapperScript.push(`${rejectFuncName}(err);`);
	wrapperScript.push("}");
	wrapperScript.push(comment);

	const extensionFunc: () => Promise<void> = new AsyncFunction(
		"extensionContext",
		resolveFuncName,
		rejectFuncName,
		waitForDependencyFuncName,
		wrapperScript.join("\n"),
	).bind(
		context,
		context,
		resolveExtensionLoad,
		rejectExtensionLoad,
		waitForDependency,
	);

	if (isCanceled()) return;
	await extensionFunc();
}
