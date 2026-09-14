import { Flex, Slider, Switch, Text, TextField } from "@radix-ui/themes";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	type BackgroundRendererOptions,
	getBackgroundColorPickerValue as pickerValue,
} from "../../utils/background-renderer-options.ts";
import type { SongVideoBaseRendererMode } from "../../utils/db-client.ts";

function NumericOption({
	label,
	value,
	min,
	max,
	step,
	disabled,
	onSave,
}: {
	label: string;
	value: number;
	min: number;
	max: number;
	step: number;
	disabled: boolean;
	onSave: (value: number) => Promise<boolean>;
}) {
	const [draft, setDraft] = useState(String(value));
	useEffect(() => setDraft(String(value)), [value]);
	const commit = async () => {
		const parsed = Number(draft);
		if (!draft.trim() || !Number.isFinite(parsed)) {
			setDraft(String(value));
			return;
		}
		const normalized = Math.min(
			max,
			Math.max(min, step === 1 ? Math.round(parsed) : parsed),
		);
		setDraft(String(normalized));
		if (normalized !== value && !(await onSave(normalized)))
			setDraft(String(value));
	};
	return (
		<label>
			<Flex justify="between" align="center" gap="3" wrap="wrap">
				<Text>{label}</Text>
				<TextField.Root
					type="number"
					value={draft}
					min={min}
					max={max}
					step={step}
					aria-label={label}
					disabled={disabled}
					style={{ width: "7em" }}
					onChange={(event) => setDraft(event.currentTarget.value)}
					onBlur={() => void commit()}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							event.preventDefault();
							event.currentTarget.blur();
						}
					}}
				/>
			</Flex>
		</label>
	);
}

export function SongBackgroundRendererOptions({
	rendererMode,
	options,
	disabled,
	onSave,
}: {
	rendererMode: SongVideoBaseRendererMode;
	options: BackgroundRendererOptions;
	disabled: boolean;
	onSave: (options: BackgroundRendererOptions) => Promise<boolean>;
}) {
	const { t } = useTranslation();
	const [intensity, setIntensity] = useState(options.animationIntensity);
	const [css, setCss] = useState(options.cssBackground);
	useEffect(
		() => setIntensity(options.animationIntensity),
		[options.animationIntensity],
	);
	useEffect(() => setCss(options.cssBackground), [options.cssBackground]);
	const saveIntensity = async (value: number) => {
		setIntensity(value);
		const saved = await onSave({ ...options, animationIntensity: value });
		if (!saved) setIntensity(options.animationIntensity);
		return saved;
	};
	const saveCss = async () => {
		const value = css.trim() || "#111111";
		setCss(value);
		if (
			value !== options.cssBackground &&
			!(await onSave({ ...options, cssBackground: value }))
		) {
			setCss(options.cssBackground);
		}
	};
	const intensityLabel = t(
		"page.settings.lyricBackground.lyricBackgroundAnimationIntensity.label",
		"节拍动画强度倍率",
	);
	const cssLabel = t(
		"page.settings.lyricBackground.lyricBackgroundColor.label",
		"CSS 背景属性值",
	);
	return (
		<Flex direction="column" gap="4">
			{rendererMode === "css-bg" ? (
				<div>
					<Text as="div" mb="1">
						{cssLabel}
					</Text>
					<Text as="div" size="2" color="gray" mb="2">
						{t(
							"page.settings.lyricBackground.lyricBackgroundColor.description",
							"等同于放入 background 样式的字符串值，默认为 #111111",
						)}
					</Text>
					<Flex gap="2" align="center" wrap="wrap">
						<input
							type="color"
							value={pickerValue(css)}
							disabled={disabled}
							aria-label={t(
								"page.settings.lyricBackground.lyricBackgroundColor.picker",
								"选择纯色背景",
							)}
							onChange={(event) => setCss(event.currentTarget.value)}
							onBlur={() => void saveCss()}
							style={{ width: 42, height: 34, padding: 0, border: 0 }}
						/>
						<TextField.Root
							value={css}
							disabled={disabled}
							aria-label={cssLabel}
							maxLength={1024}
							style={{ flex: "1 1 200px" }}
							onChange={(event) => setCss(event.currentTarget.value)}
							onBlur={() => void saveCss()}
							onKeyDown={(event) => {
								if (event.key === "Enter") {
									event.preventDefault();
									event.currentTarget.blur();
								}
							}}
						/>
					</Flex>
				</div>
			) : (
				<>
					<NumericOption
						label={t(
							"page.settings.lyricBackground.lyricBackgroundFPS.label",
							"背景最高帧数",
						)}
						value={options.fps}
						min={1}
						max={1000}
						step={1}
						disabled={disabled}
						onSave={(fps) => onSave({ ...options, fps })}
					/>
					{rendererMode === "mesh" && (
						<Flex direction="column" gap="2">
							<NumericOption
								label={intensityLabel}
								value={intensity}
								min={0}
								max={2}
								step={0.05}
								disabled={disabled}
								onSave={saveIntensity}
							/>
							<Text size="2" color="gray">
								{t(
									"page.settings.lyricBackground.lyricBackgroundAnimationIntensity.description",
									"调节网格渐变背景跟随音乐节拍的呼吸与旋转幅度。1× 保持当前效果，0× 关闭节拍响应，最高可调至 2×。",
								)}
							</Text>
							<Slider
								min={0}
								max={2}
								step={0.05}
								value={[intensity]}
								disabled={disabled}
								aria-label={intensityLabel}
								onValueChange={([value]) =>
									setIntensity(value ?? options.animationIntensity)
								}
								onValueCommit={([value]) =>
									void saveIntensity(value ?? options.animationIntensity)
								}
							/>
						</Flex>
					)}
					<NumericOption
						label={t(
							"page.settings.lyricBackground.lyricBackgroundRenderScale.label",
							"背景渲染倍率",
						)}
						value={options.renderScale}
						min={0.01}
						max={10}
						step={0.01}
						disabled={disabled}
						onSave={(renderScale) => onSave({ ...options, renderScale })}
					/>
					<label>
						<Flex align="center" justify="between" gap="3">
							<Text>
								{t(
									"page.settings.lyricBackground.lyricBackgroundStaticMode.label",
									"背景静态模式",
								)}
							</Text>
							<Switch
								checked={options.staticMode}
								disabled={disabled}
								onCheckedChange={(staticMode) =>
									void onSave({ ...options, staticMode })
								}
							/>
						</Flex>
					</label>
				</>
			)}
		</Flex>
	);
}
