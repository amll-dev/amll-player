import { ExclamationTriangleIcon } from "@radix-ui/react-icons";
import { Box, Button, Callout, Dialog, Flex, Text } from "@radix-ui/themes";
import { invoke } from "@tauri-apps/api/core";
import { type FC, useEffect, useState } from "react";

interface LinuxWebviewPrompt {
	configPath: string;
}

export const LinuxWebviewStartupPrompt: FC = () => {
	const [prompt, setPrompt] = useState<LinuxWebviewPrompt | null>(null);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let active = true;
		invoke<LinuxWebviewPrompt | null>("get_linux_webview_startup_prompt")
			.then((result) => {
				if (active) setPrompt(result);
			})
			.catch((reason) =>
				console.error("Failed to get Linux webview prompt:", reason),
			);
		return () => {
			active = false;
		};
	}, []);

	const saveChoice = async (backend: "system" | "openbox") => {
		setSaving(true);
		setError(null);
		try {
			await invoke("set_linux_webview_backend", { backend });
			if (backend === "openbox") return setPrompt(null);
			await invoke("restart_linux_webview_with_system_backend");
		} catch (reason) {
			setError(String(reason));
		} finally {
			setSaving(false);
		}
	};

	if (!prompt) return null;

	return (
		<Dialog.Root open>
			<Dialog.Content
				maxWidth="520px"
				onPointerDownOutside={(event) => event.preventDefault()}
				onEscapeKeyDown={(event) => event.preventDefault()}
			>
				<Dialog.Title>检测到可能不稳定的 Linux 显示环境</Dialog.Title>
				<Dialog.Description size="2">
					当前会话使用 NVIDIA GPU 和 Wayland。部分 WebKitGTK
					版本在该组合下可能出现显式同步崩溃、黑屏或背景丢失。
				</Dialog.Description>

				<Callout.Root color="amber" size="1" my="3">
					<Callout.Icon>
						<ExclamationTriangleIcon />
					</Callout.Icon>
					<Callout.Text>
						此确认框已在临时 Xephyr + Openbox
						会话中安全显示。选择保留当前环境会重启到原生后端。
					</Callout.Text>
				</Callout.Root>

				<Box mb="3">
					<Text as="div" size="2" color="gray">
						选择会保存到：<code>{prompt.configPath}</code>
					</Text>
					<Text as="div" size="2" color="gray" mt="1">
						可自行修改其中的 <code>backend</code> 为 <code>openbox</code>、
						<code>system</code>、<code>x11</code>、<code>wayland</code> 或{" "}
						<code>wayland-software</code>。
					</Text>
				</Box>

				{error && (
					<Text as="div" size="2" color="red" mb="3">
						{error}
					</Text>
				)}

				<Flex gap="3" justify="end">
					<Button
						variant="soft"
						color="gray"
						disabled={saving}
						onClick={() => saveChoice("system")}
					>
						保持当前环境
					</Button>
					<Button disabled={saving} onClick={() => saveChoice("openbox")}>
						使用兼容模式
					</Button>
				</Flex>
			</Dialog.Content>
		</Dialog.Root>
	);
};
