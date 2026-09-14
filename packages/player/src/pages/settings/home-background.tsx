import { Button, Card, Flex, Select, Text, TextField } from "@radix-ui/themes";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
	type FC,
	type PropsWithChildren,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";
import {
	homeBackgroundConfigAtom,
	homeBackgroundLoadedAtom,
} from "../../states/homeBackgroundAtoms.ts";
import {
	applyHomeBackgroundAsset,
	discardHomeBackgroundAsset,
	nextHomeBackgroundMutationId,
	pickAndImportHomeBackgroundAsset,
	resetHomeBackground,
	setHomeBackgroundColor,
} from "../../utils/home-background-client.ts";
import {
	type HomeBackgroundAssetKind,
	type HomeBackgroundConfig,
	type HomeBackgroundMode,
	type ImportedHomeBackgroundAsset,
	normalizeHomeBackgroundColor,
} from "../../utils/home-background-state.ts";
import styles from "./index.module.css";

interface QueuedColorSave {
	color: string;
	mutationId: number;
}

let latestPublishedHomeBackgroundMutationId = 0;

function publishHomeBackgroundConfig(
	mutationId: number,
	config: HomeBackgroundConfig,
	setConfig: (config: HomeBackgroundConfig) => void,
	setLoaded: (loaded: boolean) => void,
): boolean {
	if (mutationId < latestPublishedHomeBackgroundMutationId) return false;
	latestPublishedHomeBackgroundMutationId = mutationId;
	setConfig(config);
	setLoaded(true);
	return true;
}

const SettingEntry: FC<
	PropsWithChildren<{ label: string; description?: string }>
> = ({ label, description, children }) => (
	<Card mt="2">
		<Flex direction="row" align="center" gap="4" wrap="wrap">
			<Flex direction="column" flexGrow="1">
				<Text as="div">{label}</Text>
				{description && (
					<Text as="div" color="gray" size="2" className={styles.desc}>
						{description}
					</Text>
				)}
			</Flex>
			{children}
		</Flex>
	</Card>
);

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function probeImage(source: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const image = new Image();
		let settled = false;
		const timeout = window.setTimeout(() => {
			if (settled) return;
			settled = true;
			image.src = "";
			reject(new Error("Timed out while decoding the selected image"));
		}, 15_000);
		image.onload = () => {
			if (settled) return;
			settled = true;
			window.clearTimeout(timeout);
			image.src = "";
			resolve();
		};
		image.onerror = () => {
			if (settled) return;
			settled = true;
			window.clearTimeout(timeout);
			image.src = "";
			reject(new Error("The selected image cannot be decoded"));
		};
		image.src = source;
	});
}

function probeVideo(source: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const video = document.createElement("video");
		let settled = false;
		const cleanup = () => {
			video.onloadeddata = null;
			video.onerror = null;
			video.pause();
			video.removeAttribute("src");
			video.load();
		};
		const timeout = window.setTimeout(() => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(new Error("Timed out while decoding the selected video"));
		}, 15_000);
		video.preload = "auto";
		video.muted = true;
		video.playsInline = true;
		video.onloadeddata = () => {
			if (settled) return;
			if (video.videoWidth <= 0 || video.videoHeight <= 0) {
				settled = true;
				window.clearTimeout(timeout);
				cleanup();
				reject(new Error("The selected video has invalid dimensions"));
				return;
			}
			settled = true;
			window.clearTimeout(timeout);
			cleanup();
			resolve();
		};
		video.onerror = () => {
			if (settled) return;
			settled = true;
			window.clearTimeout(timeout);
			cleanup();
			reject(new Error("The selected video cannot be decoded"));
		};
		video.src = source;
		video.load();
	});
}

function fileName(filePath: string | null): string {
	if (!filePath) return "";
	return filePath.split(/[\\/]/).pop() ?? filePath;
}

function formatBytes(bytes: number | null): string {
	if (!bytes || bytes <= 0) return "";
	const units = ["B", "KiB", "MiB", "GiB"];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export const HomeBackgroundSettings: FC = () => {
	const { t } = useTranslation();
	const [config, setConfig] = useAtom(homeBackgroundConfigAtom);
	const loaded = useAtomValue(homeBackgroundLoadedAtom);
	const setLoaded = useSetAtom(homeBackgroundLoadedAtom);
	const [busy, setBusy] = useState(false);
	const [draftColor, setDraftColor] = useState(config.color);
	const mountedRef = useRef(true);
	const operationRef = useRef(0);
	const pendingAssetsRef = useRef(new Set<string>());
	const queuedColorRef = useRef<QueuedColorSave | null>(null);
	const colorSaveRunningRef = useRef(false);

	useEffect(() => {
		if (!colorSaveRunningRef.current) setDraftColor(config.color);
	}, [config.color]);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			operationRef.current += 1;
			queuedColorRef.current = null;
			for (const assetId of pendingAssetsRef.current) {
				void discardHomeBackgroundAsset(assetId).catch((error) => {
					console.warn("Failed to discard a pending home background", error);
				});
			}
			pendingAssetsRef.current.clear();
		};
	}, []);

	const discardCandidate = useCallback(async (assetId: string) => {
		try {
			await discardHomeBackgroundAsset(assetId);
		} catch (error) {
			console.warn("Failed to discard a pending home background", error);
		} finally {
			pendingAssetsRef.current.delete(assetId);
		}
	}, []);

	const queueColorSave = useCallback(
		(color: string) => {
			queuedColorRef.current = {
				color: normalizeHomeBackgroundColor(color),
				mutationId: nextHomeBackgroundMutationId(),
			};
			if (colorSaveRunningRef.current) return;

			colorSaveRunningRef.current = true;
			if (mountedRef.current) setBusy(true);
			void (async () => {
				try {
					while (queuedColorRef.current) {
						const queued = queuedColorRef.current;
						queuedColorRef.current = null;
						try {
							const next = await setHomeBackgroundColor(
								queued.color,
								queued.mutationId,
							);
							publishHomeBackgroundConfig(
								queued.mutationId,
								next,
								setConfig,
								setLoaded,
							);
						} catch (error) {
							if (mountedRef.current) {
								if (!queuedColorRef.current) {
									setDraftColor(config.color);
								}
								toast.error(
									t("page.settings.homeBackground.error.save", {
										defaultValue: "无法保存首页背景设置：{message}",
										message: getErrorMessage(error),
									}),
								);
							}
						}
					}
				} finally {
					colorSaveRunningRef.current = false;
					if (mountedRef.current) setBusy(false);
				}
			})();
		},
		[config.color, setConfig, setLoaded, t],
	);

	const chooseAsset = useCallback(
		async (kind: HomeBackgroundAssetKind) => {
			if (busy) return;
			setBusy(true);
			const operation = ++operationRef.current;
			const mutationId = nextHomeBackgroundMutationId();
			let imported: ImportedHomeBackgroundAsset | null = null;
			try {
				imported = await pickAndImportHomeBackgroundAsset(
					kind,
					t(
						kind === "image"
							? "page.settings.homeBackground.asset.chooseImage"
							: "page.settings.homeBackground.asset.chooseVideo",
						kind === "image" ? "选择背景图像" : "选择背景视频",
					),
				);
				if (!imported) return;
				pendingAssetsRef.current.add(imported.assetId);
				if (!mountedRef.current || operationRef.current !== operation) {
					await discardCandidate(imported.assetId);
					return;
				}
				const source = convertFileSrc(imported.filePath);
				if (kind === "image") await probeImage(source);
				else await probeVideo(source);
				if (!mountedRef.current || operationRef.current !== operation) {
					await discardCandidate(imported.assetId);
					return;
				}
				const applied = await applyHomeBackgroundAsset(
					imported.assetId,
					kind,
					mutationId,
				);
				pendingAssetsRef.current.delete(imported.assetId);
				imported = null;
				if (!mountedRef.current || operationRef.current === operation) {
					publishHomeBackgroundConfig(
						mutationId,
						applied,
						setConfig,
						setLoaded,
					);
				}
				if (mountedRef.current && operationRef.current === operation) {
					toast.success(
						t("page.settings.homeBackground.success.asset", "首页背景已应用"),
					);
				}
			} catch (error) {
				if (imported) await discardCandidate(imported.assetId);
				if (mountedRef.current && operationRef.current === operation) {
					toast.error(
						t("page.settings.homeBackground.error.asset", {
							defaultValue: "无法应用首页背景：{message}",
							message: getErrorMessage(error),
						}),
					);
				}
			} finally {
				if (mountedRef.current && operationRef.current === operation) {
					setBusy(false);
				}
			}
		},
		[busy, discardCandidate, setConfig, setLoaded, t],
	);

	const changeSimpleMode = useCallback(
		async (mode: "default" | "color", color = draftColor) => {
			if (busy) return;
			setBusy(true);
			const operation = ++operationRef.current;
			const mutationId = nextHomeBackgroundMutationId();
			try {
				const next =
					mode === "default"
						? await resetHomeBackground(mutationId)
						: await setHomeBackgroundColor(
								normalizeHomeBackgroundColor(color),
								mutationId,
							);
				if (!mountedRef.current || operationRef.current === operation) {
					publishHomeBackgroundConfig(mutationId, next, setConfig, setLoaded);
				}
			} catch (error) {
				if (mountedRef.current && operationRef.current === operation) {
					toast.error(
						t("page.settings.homeBackground.error.save", {
							defaultValue: "无法保存首页背景设置：{message}",
							message: getErrorMessage(error),
						}),
					);
				}
			} finally {
				if (mountedRef.current && operationRef.current === operation) {
					setBusy(false);
				}
			}
		},
		[busy, draftColor, setConfig, setLoaded, t],
	);

	const onModeChange = (mode: string) => {
		switch (mode as HomeBackgroundMode) {
			case "default":
				void changeSimpleMode("default");
				break;
			case "color":
				void changeSimpleMode("color");
				break;
			case "image":
			case "video":
				void chooseAsset(mode as HomeBackgroundAssetKind);
				break;
		}
	};

	const commitDraftColor = () => {
		const normalized = draftColor.trim().toLowerCase();
		if (!/^#[0-9a-f]{6}$/.test(normalized)) {
			setDraftColor(config.color);
			toast.error(
				t(
					"page.settings.homeBackground.error.color",
					"请输入 #RRGGBB 格式的颜色值",
				),
			);
			return;
		}
		void changeSimpleMode("color", normalized);
	};

	return (
		<>
			<SettingEntry
				label={t("page.settings.homeBackground.mode.label", "背景类型")}
				description={t(
					"page.settings.homeBackground.mode.description",
					"图像和视频会复制到应用数据目录，原文件移动后仍可使用。",
				)}
			>
				<Select.Root
					value={config.mode}
					onValueChange={onModeChange}
					disabled={busy || !loaded}
				>
					<Select.Trigger
						aria-label={t(
							"page.settings.homeBackground.mode.label",
							"背景类型",
						)}
					/>
					<Select.Content>
						<Select.Item value="default">
							{t("page.settings.homeBackground.mode.menu.default", "默认")}
						</Select.Item>
						<Select.Item value="image">
							{t("page.settings.homeBackground.mode.menu.image", "图像")}
						</Select.Item>
						<Select.Item value="video">
							{t("page.settings.homeBackground.mode.menu.video", "视频")}
						</Select.Item>
						<Select.Item value="color">
							{t("page.settings.homeBackground.mode.menu.color", "纯色")}
						</Select.Item>
					</Select.Content>
				</Select.Root>
			</SettingEntry>

			{config.mode === "color" && (
				<SettingEntry
					label={t("page.settings.homeBackground.color.label", "背景颜色")}
					description={t(
						"page.settings.homeBackground.color.description",
						"使用不透明纯色覆盖当前系统材质背景。",
					)}
				>
					<Flex gap="2" align="center" wrap="wrap">
						<input
							type="color"
							value={normalizeHomeBackgroundColor(draftColor)}
							aria-label={t(
								"page.settings.homeBackground.color.picker",
								"选择首页背景颜色",
							)}
							disabled={!loaded || (busy && !colorSaveRunningRef.current)}
							onChange={(event) => {
								const color = event.currentTarget.value;
								setDraftColor(color);
								queueColorSave(color);
							}}
							style={{ width: 42, height: 34, padding: 0, border: 0 }}
						/>
						<TextField.Root
							value={draftColor}
							aria-label={t(
								"page.settings.homeBackground.color.label",
								"背景颜色",
							)}
							disabled={busy || !loaded}
							onChange={(event) => setDraftColor(event.currentTarget.value)}
							onBlur={commitDraftColor}
							onKeyDown={(event) => {
								if (event.key === "Enter") {
									event.currentTarget.blur();
								}
							}}
						/>
					</Flex>
				</SettingEntry>
			)}

			{(config.mode === "image" || config.mode === "video") && (
				<SettingEntry
					label={t(
						"page.settings.homeBackground.asset.label",
						config.mode === "image" ? "背景图像" : "背景视频",
					)}
					description={`${fileName(config.filePath)}${
						config.bytes ? ` · ${formatBytes(config.bytes)}` : ""
					}`}
				>
					<Button
						variant="soft"
						disabled={busy || !loaded}
						onClick={() =>
							void chooseAsset(config.mode as HomeBackgroundAssetKind)
						}
					>
						{t(
							"page.settings.homeBackground.asset.replace",
							config.mode === "image" ? "更换图像" : "更换视频",
						)}
					</Button>
				</SettingEntry>
			)}
		</>
	);
};
