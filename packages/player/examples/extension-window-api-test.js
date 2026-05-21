// @id amll-extension-window-api-test
// @version 1.0.0
// @name 扩展窗口 API 测试器
// @description 覆盖扩展窗口创建、查询、显示、隐藏、聚焦、居中、改标题、改尺寸、改位置、关闭、关闭全部和组件注册的测试插件。
// @icon data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='16' fill='%2300aaff'/%3E%3Cpath d='M14 18h36v10H14zM14 34h20v12H14zM38 34h12v12H38z' fill='white'/%3E%3C/svg%3E

const { createElement: h, useEffect, useMemo, useState } = React;

const {
	Badge,
	Box,
	Button,
	Callout,
	Card,
	Code,
	DataList,
	Flex,
	Grid,
	Heading,
	ScrollArea,
	Separator,
	Table,
	Text,
	TextField,
} = RadixTheme;

const IDS = Object.freeze({
	dashboard: "dashboard",
	sandbox: "sandbox",
	child: "child",
	hidden: "hidden",
	positioned: "positioned",
	compact: "compact",
	crash: "crash",
});

const WINDOW_OPTIONS = Object.freeze({
	dashboard: {
		title: "扩展窗口 API 测试器",
		width: 1000,
		height: 720,
		minWidth: 760,
		minHeight: 540,
		center: true,
		resizable: true,
		decorations: true,
		visible: true,
	},
	sandbox: {
		title: "沙盒窗口",
		width: 740,
		height: 480,
		minWidth: 460,
		minHeight: 320,
		maxWidth: 1120,
		maxHeight: 780,
		center: true,
		resizable: true,
		decorations: true,
	},
	child: {
		title: "子窗口（从扩展窗口创建）",
		width: 560,
		height: 380,
		center: true,
	},
	hidden: {
		title: "隐藏窗口",
		width: 540,
		height: 340,
		center: true,
		visible: false,
	},
	positioned: {
		title: "定位窗口",
		width: 520,
		height: 340,
		x: 80,
		y: 80,
	},
	compact: {
		title: "紧凑窗口",
		width: 360,
		height: 260,
		center: true,
		resizable: false,
		decorations: false,
	},
	crash: {
		title: "崩溃测试窗口",
		width: 620,
		height: 380,
		center: true,
	},
});

const WINDOW_NOTES = Object.freeze({
	dashboard: "主控制台：从这里覆盖测试全部窗口 API。",
	sandbox: "沙盒窗口：用于测试窗口内部继续创建和控制窗口。",
	child:
		"子窗口：由另一个扩展窗口创建，验证 extension-window 到 extension-window 调用。",
	hidden: "隐藏窗口：以 visible:false 创建，再由 show() 显示。",
	positioned: "定位窗口：使用 x/y 创建，并可继续 setPosition。",
	compact: "紧凑窗口：使用 decorations:false 和 resizable:false 创建。",
});

function now() {
	return new Date().toLocaleTimeString();
}

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatError(err) {
	if (err instanceof Error) return err.message;
	if (typeof err === "string") return err;
	try {
		return JSON.stringify(err);
	} catch {
		return String(err);
	}
}

function describeHandle(handle) {
	return `${handle.id} / ${handle.label}`;
}

async function createAndFocus(id, options) {
	const handle = await extensionContext.windows.create(id, options);
	await handle.focus();
	return handle;
}

async function currentWindowHandle() {
	const windowId = extensionContext.window?.id;
	if (!windowId) throw new Error("当前上下文不是扩展窗口");
	const handle = await extensionContext.windows.get(windowId);
	if (!handle) throw new Error(`找不到当前窗口句柄：${windowId}`);
	return handle;
}

function useOperationLog(initialMessage) {
	const [logs, setLogs] = useState(() =>
		initialMessage
			? [
					{
						id: `${Date.now()}-init`,
						time: now(),
						level: "信息",
						message: initialMessage,
					},
				]
			: [],
	);

	const addLog = (level, message) => {
		setLogs((items) =>
			[
				{
					id: `${Date.now()}-${Math.random()}`,
					time: now(),
					level,
					message,
				},
				...items,
			].slice(0, 48),
		);
	};

	const run = async (label, action) => {
		addLog("执行", label);
		try {
			const result = await action();
			addLog("成功", result ? `${label}：${result}` : label);
		} catch (err) {
			addLog("失败", `${label}：${formatError(err)}`);
		}
	};

	return {
		logs,
		run,
		clearLogs: () => setLogs([]),
	};
}

function Page({ children, compact = false }) {
	return h(
		Box,
		{
			style: {
				height: "100vh",          // 固定为窗口高度，不再使用 minHeight
				overflowY: "auto",        // 内容超出时显示垂直滚动条
				boxSizing: "border-box",
				padding: compact ? 16 : 24,
				background:
					"radial-gradient(circle at 16% 8%, rgba(0, 170, 255, .18), transparent 34%), radial-gradient(circle at 90% 0%, rgba(52, 211, 153, .14), transparent 26%), var(--gray-1)",
			},
		},
		children,
	);
}

function Header({ title, description, badge }) {
	return h(
		Flex,
		{ direction: "column", gap: "3", mb: "5" },
		h(
			Flex,
			{ align: "center", gap: "3", wrap: "wrap" },
			h(Heading, { size: "7" }, title),
			badge ? h(Badge, { color: "cyan", size: "2" }, badge) : null,
		),
		h(Text, { color: "gray", size: "3" }, description),
	);
}

function SectionCard({ title, description, children }) {
	return h(
		Card,
		{ size: "3" },
		h(
			Flex,
			{ direction: "column", gap: "3" },
			h(
				Flex,
				{ direction: "column", gap: "1" },
				h(Heading, { size: "4" }, title),
				description ? h(Text, { color: "gray", size: "2" }, description) : null,
			),
			children,
		),
	);
}

function RuntimeInfoCard() {
	return h(
		Card,
		{ size: "3" },
		h(Heading, { size: "4", mb: "3" }, "当前运行时"),
		h(
			DataList.Root,
			{ size: "2" },
			h(
				DataList.Item,
				null,
				h(DataList.Label, null, "API 版本"),
				h(
					DataList.Value,
					null,
					h(Code, null, extensionContext.extensionApiNumber),
				),
			),
			h(
				DataList.Item,
				null,
				h(DataList.Label, null, "运行环境"),
				h(DataList.Value, null, h(Code, null, extensionContext.runtime.kind)),
			),
			h(
				DataList.Item,
				null,
				h(DataList.Label, null, "窗口 ID"),
				h(
					DataList.Value,
					null,
					h(Code, null, extensionContext.window?.id ?? "main"),
				),
			),
			h(
				DataList.Item,
				null,
				h(DataList.Label, null, "窗口 Label"),
				h(
					DataList.Value,
					null,
					h(Code, null, extensionContext.window?.label ?? "-"),
				),
			),
		),
	);
}

function OperationLog({ logs, onClear }) {
	const colorOf = (level) => {
		if (level === "失败") return "red";
		if (level === "成功") return "green";
		if (level === "执行") return "blue";
		return "gray";
	};

	return h(
		Card,
		{ size: "3" },
		h(
			Flex,
			{ justify: "between", align: "center", gap: "3", mb: "3" },
			h(Heading, { size: "4" }, "操作日志"),
			h(Button, { variant: "soft", size: "2", onClick: onClear }, "清空"),
		),
		logs.length === 0
			? h(Text, { color: "gray", size: "2" }, "暂无日志")
			: h(
					ScrollArea,
					{ style: { maxHeight: 280 } },
					h(
						Table.Root,
						{ size: "1", variant: "surface" },
						h(
							Table.Header,
							null,
							h(
								Table.Row,
								null,
								h(Table.ColumnHeaderCell, null, "时间"),
								h(Table.ColumnHeaderCell, null, "状态"),
								h(Table.ColumnHeaderCell, null, "内容"),
							),
						),
						h(
							Table.Body,
							null,
							...logs.map((item) =>
								h(
									Table.Row,
									{ key: item.id },
									h(Table.Cell, null, item.time),
									h(
										Table.Cell,
										null,
										h(Badge, { color: colorOf(item.level) }, item.level),
									),
									h(Table.Cell, null, item.message),
								),
							),
						),
					),
				),
	);
}

function ActionCard({ title, description, onClick, color = "blue" }) {
	return h(
		Card,
		{ size: "2" },
		h(
			Flex,
			{ direction: "column", gap: "3", height: "100%" },
			h(Heading, { size: "3" }, title),
			h(Text, { color: "gray", size: "2" }, description),
			h(Box, { style: { flex: 1 } }),
			h(Button, { color, onClick }, "执行"),
		),
	);
}

function ParameterPanel({
	title,
	setTitle,
	width,
	setWidth,
	height,
	setHeight,
	x,
	setX,
	y,
	setY,
}) {
	return h(
		SectionCard,
		{
			title: "参数输入",
			description: "这些值会用于标题、尺寸和位置测试。",
		},
		h(
			Flex,
			{ direction: "column", gap: "3" },
			h(
				Box,
				null,
				h(Text, { as: "label", size: "2", weight: "bold" }, "窗口标题"),
				h(TextField.Root, {
					value: title,
					onChange: (event) => setTitle(event.target.value),
				}),
			),
			h(
				Grid,
				{ columns: "2", gap: "3" },
				h(
					Box,
					null,
					h(Text, { as: "label", size: "2", weight: "bold" }, "宽度"),
					h(TextField.Root, {
						type: "number",
						value: width,
						onChange: (event) => setWidth(event.target.value),
					}),
				),
				h(
					Box,
					null,
					h(Text, { as: "label", size: "2", weight: "bold" }, "高度"),
					h(TextField.Root, {
						type: "number",
						value: height,
						onChange: (event) => setHeight(event.target.value),
					}),
				),
				h(
					Box,
					null,
					h(Text, { as: "label", size: "2", weight: "bold" }, "X 坐标"),
					h(TextField.Root, {
						type: "number",
						value: x,
						onChange: (event) => setX(event.target.value),
					}),
				),
				h(
					Box,
					null,
					h(Text, { as: "label", size: "2", weight: "bold" }, "Y 坐标"),
					h(TextField.Root, {
						type: "number",
						value: y,
						onChange: (event) => setY(event.target.value),
					}),
				),
			),
		),
	);
}

function DashboardWindow() {
	const { logs, run, clearLogs } = useOperationLog(
		"控制台已加载，可以从这里覆盖测试所有窗口 API。",
	);
	const [title, setTitle] = useState("沙盒窗口 - 标题已更新");
	const [width, setWidth] = useState("760");
	const [height, setHeight] = useState("500");
	const [x, setX] = useState("90");
	const [y, setY] = useState("90");

	const sandbox = () =>
		extensionContext.windows.create(IDS.sandbox, WINDOW_OPTIONS.sandbox);
	const actions = [
		{
			title: "创建/聚焦沙盒",
			description: "create + focus，包含尺寸约束、居中、可调整尺寸。",
			onClick: () =>
				run("创建/聚焦沙盒窗口", async () =>
					describeHandle(
						await createAndFocus(IDS.sandbox, WINDOW_OPTIONS.sandbox),
					),
				),
		},
		{
			title: "重复创建同 ID",
			description: "验证相同 windowId 会复用并聚焦已有窗口。",
			onClick: () =>
				run("重复创建 sandbox", async () => {
					const first = await sandbox();
					const second = await sandbox();
					await second.focus();
					return first.label === second.label
						? `已复用：${second.label}`
						: `不同 label：${first.label} / ${second.label}`;
				}),
		},
		{
			title: "查询沙盒",
			description: "get，检查窗口是否存在并返回句柄。",
			onClick: () =>
				run("查询 sandbox", async () => {
					const handle = await extensionContext.windows.get(IDS.sandbox);
					return handle ? describeHandle(handle) : "未找到 sandbox";
				}),
		},
		{
			title: "隐藏后显示沙盒",
			description: "hide + show + focus。",
			onClick: () =>
				run("隐藏 sandbox 1.2 秒再显示", async () => {
					const handle = await sandbox();
					await handle.hide();
					await delay(1200);
					await handle.show();
					await handle.focus();
					return "已重新显示";
				}),
		},
		{
			title: "改沙盒标题",
			description: "setTitle，使用参数输入中的标题。",
			onClick: () =>
				run("修改 sandbox 标题", async () => {
					const handle = await sandbox();
					await handle.setTitle(title);
					return title;
				}),
		},
		{
			title: "改沙盒尺寸",
			description: "setSize，使用参数输入中的宽高。",
			onClick: () =>
				run("修改 sandbox 尺寸", async () => {
					const handle = await sandbox();
					await handle.setSize(Number(width), Number(height));
					return `${width} x ${height}`;
				}),
		},
		{
			title: "居中沙盒",
			description: "center，将窗口移到屏幕中央。",
			onClick: () =>
				run("居中 sandbox", async () => {
					const handle = await sandbox();
					await handle.center();
					await handle.focus();
					return "已居中";
				}),
		},
		{
			title: "打开定位窗口",
			description: "create(x/y) + setPosition。",
			onClick: () =>
				run("打开并移动 positioned", async () => {
					const handle = await createAndFocus(IDS.positioned, {
						...WINDOW_OPTIONS.positioned,
						x: Number(x),
						y: Number(y),
					});
					await handle.setPosition(Number(x), Number(y));
					return `${describeHandle(handle)} @ ${x}, ${y}`;
				}),
		},
		{
			title: "创建不可见窗口",
			description: "visible:false，然后 show + focus。",
			onClick: () =>
				run("创建 hidden 后显示", async () => {
					const handle = await extensionContext.windows.create(
						IDS.hidden,
						WINDOW_OPTIONS.hidden,
					);
					await delay(800);
					await handle.show();
					await handle.focus();
					return `${describeHandle(handle)}，已显示`;
				}),
		},
		{
			title: "打开紧凑窗口",
			description: "decorations:false + resizable:false。",
			onClick: () =>
				run("打开 compact", async () =>
					describeHandle(
						await createAndFocus(IDS.compact, WINDOW_OPTIONS.compact),
					),
				),
		},
		{
			title: "打开子窗口",
			description: "从扩展窗口控制台再创建一个扩展窗口。",
			onClick: () =>
				run("打开 child", async () =>
					describeHandle(await createAndFocus(IDS.child, WINDOW_OPTIONS.child)),
				),
		},
		{
			title: "崩溃页测试",
			description: "窗口组件主动抛错，验证宿主错误页。",
			onClick: () =>
				run("打开 crash", async () => {
					const handle = await createAndFocus(IDS.crash, WINDOW_OPTIONS.crash);
					return `${describeHandle(handle)}，应显示错误页`;
				}),
		},
		{
			title: "非法 ID 测试",
			description: 'create("bad id!")，预期失败并记录错误。',
			onClick: () =>
				run("尝试非法窗口 ID（预期失败）", async () => {
					await extensionContext.windows.create("bad id!", {
						title: "非法窗口",
					});
					return "不应成功";
				}),
		},
		{
			title: "关闭沙盒",
			description: "windows.close(id)，关闭指定窗口。",
			color: "red",
			onClick: () =>
				run("关闭 sandbox", async () => {
					await extensionContext.windows.close(IDS.sandbox);
					return "已请求关闭";
				}),
		},
		{
			title: "关闭全部窗口",
			description: "windows.closeAll()，关闭当前扩展创建的所有窗口。",
			color: "red",
			onClick: () =>
				run("关闭全部窗口", async () => {
					await extensionContext.windows.closeAll();
					return "已请求关闭全部窗口";
				}),
		},
	];

	return h(
		Page,
		null,
		h(Header, {
			title: "扩展窗口 API 测试器",
			description:
				"中文测试插件，使用 AMLL Player 内置的 Radix UI 组件覆盖扩展窗口全部公开操作。",
			badge: "控制窗口",
		}),
		h(
			Callout.Root,
			{ color: "cyan", mb: "4" },
			h(
				Callout.Text,
				null,
				"提示：控制台本身也是扩展窗口，所以这里可以直接验证扩展窗口内再次创建窗口的权限。",
			),
		),
		h(
			Grid,
			{ columns: { initial: "1", md: "2" }, gap: "4", mb: "4" },
			h(RuntimeInfoCard),
			h(ParameterPanel, {
				title,
				setTitle,
				width,
				setWidth,
				height,
				setHeight,
				x,
				setX,
				y,
				setY,
			}),
		),
		h(
			Grid,
			{ columns: { initial: "1", sm: "2", lg: "3" }, gap: "3", mb: "4" },
			...actions.map((action) =>
				h(ActionCard, { key: action.title, ...action }),
			),
		),
		h(OperationLog, { logs, onClear: clearLogs }),
	);
}

function GenericTestWindow() {
	const windowId = extensionContext.window?.id ?? "unknown";
	const title = WINDOW_OPTIONS[windowId]?.title ?? "测试窗口";
	const note = WINDOW_NOTES[windowId] ?? "通用测试窗口。";
	const { logs, run, clearLogs } = useOperationLog(note);
	const [clock, setClock] = useState(now());
	const [count, setCount] = useState(0);

	useEffect(() => {
		const timer = setInterval(() => setClock(now()), 1000);
		return () => clearInterval(timer);
	}, []);

	const selfActions = useMemo(
		() => [
			{
				label: "聚焦控制台",
				run: () =>
					run("聚焦 dashboard", async () => {
						const handle = await extensionContext.windows.get(IDS.dashboard);
						if (!handle) return "dashboard 未打开";
						await handle.focus();
						return describeHandle(handle);
					}),
			},
			{
				label: "打开子窗口",
				run: () =>
					run("从当前窗口创建 child", async () =>
						describeHandle(
							await createAndFocus(IDS.child, WINDOW_OPTIONS.child),
						),
					),
			},
			{
				label: "改当前标题",
				run: () =>
					run("修改当前窗口标题", async () => {
						const handle = await currentWindowHandle();
						const nextTitle = `${title} ${now()}`;
						await handle.setTitle(nextTitle);
						return nextTitle;
					}),
			},
			{
				label: "改当前尺寸",
				run: () =>
					run("修改当前窗口尺寸", async () => {
						const handle = await currentWindowHandle();
						await handle.setSize(680, 440);
						return "680 x 440";
					}),
			},
			{
				label: "移动当前窗口",
				run: () =>
					run("移动当前窗口", async () => {
						const handle = await currentWindowHandle();
						await handle.setPosition(120 + count * 16, 120 + count * 16);
						return `${120 + count * 16}, ${120 + count * 16}`;
					}),
			},
			{
				label: "居中当前窗口",
				run: () =>
					run("居中当前窗口", async () => {
						const handle = await currentWindowHandle();
						await handle.center();
						return "已居中";
					}),
			},
			{
				label: "隐藏后显示",
				run: () =>
					run("隐藏当前窗口 1 秒再显示", async () => {
						const handle = await currentWindowHandle();
						await handle.hide();
						await delay(1000);
						await handle.show();
						await handle.focus();
						return "已重新显示";
					}),
			},
			{
				label: "关闭当前窗口",
				run: () =>
					run("关闭当前窗口", async () => {
						const handle = await currentWindowHandle();
						await handle.close();
						return "已请求关闭";
					}),
				color: "red",
			},
		],
		[count, run, title],
	);

	return h(
		Page,
		{ compact: windowId === IDS.compact },
		h(Header, {
			title,
			description: `${note} 当前时间：${clock}`,
			badge: windowId,
		}),
		h(
			Grid,
			{ columns: { initial: "1", md: "2" }, gap: "4", mb: "4" },
			h(RuntimeInfoCard),
			h(
				SectionCard,
				{ title: "窗口内自测" },
				h(
					Flex,
					{ gap: "3", wrap: "wrap" },
					h(
						Button,
						{ onClick: () => setCount((value) => value + 1) },
						`点击计数：${count}`,
					),
					...selfActions.map((action) =>
						h(
							Button,
							{
								key: action.label,
								color: action.color,
								variant: action.color === "red" ? "soft" : undefined,
								onClick: action.run,
							},
							action.label,
						),
					),
				),
			),
		),
		h(OperationLog, { logs, onClear: clearLogs }),
	);
}

function CrashWindow() {
	throw new Error(
		"这是测试插件故意抛出的错误，用于验证扩展窗口宿主的错误边界。关闭该窗口即可继续测试。",
	);
}

function SettingsPanel() {
	const { logs, run, clearLogs } = useOperationLog(
		"设置页面板可从主窗口调用 windows API。",
	);

	return h(
		Card,
		{ size: "3", my: "3" },
		h(
			Flex,
			{ direction: "column", gap: "3" },
			h(
				Flex,
				{ align: "center", gap: "3", wrap: "wrap" },
				h(Heading, { size: "4" }, "扩展窗口 API 测试器"),
				h(Badge, { color: "cyan" }, "主窗口设置面板"),
			),
			h(
				Text,
				{ color: "gray", size: "2" },
				"点击按钮打开控制台；控制台会继续覆盖所有扩展窗口 API。",
			),
			h(
				Flex,
				{ gap: "3", wrap: "wrap" },
				h(
					Button,
					{
						onClick: () =>
							run("打开控制台", async () =>
								describeHandle(
									await createAndFocus(IDS.dashboard, WINDOW_OPTIONS.dashboard),
								),
							),
					},
					"打开控制台",
				),
				h(
					Button,
					{
						variant: "soft",
						onClick: () =>
							run("打开沙盒", async () =>
								describeHandle(
									await createAndFocus(IDS.sandbox, WINDOW_OPTIONS.sandbox),
								),
							),
					},
					"打开沙盒",
				),
				h(
					Button,
					{
						color: "red",
						variant: "soft",
						onClick: () =>
							run("关闭全部窗口", async () => {
								await extensionContext.windows.closeAll();
								return "已请求关闭全部窗口";
							}),
					},
					"关闭全部窗口",
				),
			),
			h(Separator),
			h(RuntimeInfoCard),
			h(OperationLog, { logs, onClear: clearLogs }),
		),
	);
}

extensionContext.registerWindowComponent(IDS.dashboard, DashboardWindow);
extensionContext.registerWindowComponent(IDS.sandbox, GenericTestWindow);
extensionContext.registerWindowComponent(IDS.child, GenericTestWindow);
extensionContext.registerWindowComponent(IDS.hidden, GenericTestWindow);
extensionContext.registerWindowComponent(IDS.positioned, GenericTestWindow);
extensionContext.registerWindowComponent(IDS.compact, GenericTestWindow);
extensionContext.registerWindowComponent(IDS.crash, CrashWindow);

if (extensionContext.runtime.kind === "main") {
	extensionContext.registerComponent("settings", SettingsPanel);
	extensionContext.addEventListener(
		"extension-load",
		() => {
			void createAndFocus(IDS.dashboard, WINDOW_OPTIONS.dashboard).catch(
				(err) => {
					console.error("扩展窗口 API 测试器自动打开失败", err);
				},
			);
		},
		{ once: true },
	);
}