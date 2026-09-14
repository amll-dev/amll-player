import { Box, Theme } from "@radix-ui/themes";
import classNames from "classnames";
import { useAtomValue } from "jotai";
import { lazy, StrictMode, Suspense } from "react";
import { RouterProvider } from "react-router-dom";
import { ToastContainer } from "react-toastify";
import styles from "./App.module.css";
import { AppContainer } from "./components/AppContainer/index.tsx";
import { ExtensionInjectPoint } from "./components/ExtensionInjectPoint/index.tsx";
import { HomeBackground } from "./components/HomeBackground/index.tsx";
import { LocalMusicContext } from "./components/LocalMusicContext/index.tsx";
import { MainWindowActivity } from "./components/MainWindowActivity/index.tsx";
import { MigrationDialog } from "./components/MigrationDialog/index.tsx";
import { MusicDropContext } from "./components/MusicDropContext/index.tsx";
import { NowPlayingBar } from "./components/NowPlayingBar/index.tsx";
import { ShotcutContext } from "./components/ShotcutContext/index.tsx";
import { TaskbarLyricBridge } from "./components/TaskbarLyricBridge/index.tsx";
import { ThemeManager } from "./components/ThemeManager/index.tsx";
import { TrayBridge } from "./components/TrayBridge/index.tsx";
import { UpdateContext } from "./components/UpdateContext/index.tsx";
import { WindowCloseBehavior } from "./components/WindowCloseBehavior/index.tsx";
import { WSProtocolMusicContext } from "./components/WSProtocolMusicContext/index.tsx";
import { useMigration } from "./hooks/useMigration.ts";
import { enableTaskbarLyricAtom } from "./states/appAtoms.ts";
import { effectiveHomeBackgroundConfigAtom } from "./states/homeBackgroundAtoms.ts";
import { isCustomHomeBackground } from "./utils/home-background-state.ts";
import "./i18n";
import { isLyricPageOpenedAtom } from "@applemusic-like-lyrics/react-full";
import { StatsComponent } from "./components/StatsComponent/index.tsx";
import { router } from "./router.tsx";
import {
	hasBackgroundAtom,
	isDarkThemeAtom,
	MusicContextMode,
	musicContextModeAtom,
	showStatJSFrameAtom,
} from "./states/appAtoms.ts";
import { useInitializeWindow } from "./utils/useInitializeWindow.ts";

const ExtensionContext = lazy(() => import("./components/ExtensionContext"));
const AMLLWrapper = lazy(() => import("./components/AMLLWrapper"));

function App() {
	const isLyricPageOpened = useAtomValue(isLyricPageOpenedAtom);
	const showStatJSFrame = useAtomValue(showStatJSFrameAtom);
	const enableTaskbarLyric = useAtomValue(enableTaskbarLyricAtom);
	const musicContextMode = useAtomValue(musicContextModeAtom);
	const isDarkTheme = useAtomValue(isDarkThemeAtom);
	const hasBackground = useAtomValue(hasBackgroundAtom);
	const homeBackgroundConfig = useAtomValue(effectiveHomeBackgroundConfigAtom);
	const hasCustomHomeBackground = isCustomHomeBackground(homeBackgroundConfig);
	const useDarkAppearance = isDarkTheme || hasCustomHomeBackground;

	const migration = useMigration();

	useInitializeWindow();

	return (
		<>
			{/* 上下文组件均不建议被 StrictMode 包含，以免重复加载扩展程序发生问题  */}
			<WindowCloseBehavior />
			<MainWindowActivity />
			{showStatJSFrame && <StatsComponent />}
			{musicContextMode === MusicContextMode.Local && (
				<LocalMusicContext key={MusicContextMode.Local} />
			)}
			<TrayBridge />
			{enableTaskbarLyric && <TaskbarLyricBridge />}
			{musicContextMode === MusicContextMode.WSProtocol && (
				<WSProtocolMusicContext
					key={MusicContextMode.WSProtocol}
					isLyricOnly={false}
				/>
			)}

			<UpdateContext />
			<ShotcutContext />
			<MusicDropContext />
			<ThemeManager />
			<Suspense>
				<ExtensionContext />
			</Suspense>
			<ExtensionInjectPoint injectPointName="context" hideErrorCallout />

			<StrictMode>
				<Theme
					appearance={useDarkAppearance ? "dark" : "light"}
					panelBackground="solid"
					hasBackground={hasBackground}
					className={styles.radixTheme}
				>
					<HomeBackground />
					<MigrationDialog
						state={migration}
						onStart={migration.startMigration}
						onSkip={migration.skipMigration}
						onDeleteOld={migration.deleteOldData}
						onDismiss={migration.dismiss}
					/>
					<Box
						data-amll-player-overlay-root=""
						className={classNames(
							styles.body,
							isLyricPageOpened && styles.amllOpened,
							hasCustomHomeBackground && styles.bodyWithHomeBackground,
						)}
					>
						<AppContainer
							playbar={<NowPlayingBar />}
							playbarExpanded={isLyricPageOpened}
							playbarExpandedContent={
								<Suspense>
									<AMLLWrapper />
								</Suspense>
							}
						>
							<RouterProvider router={router} />
						</AppContainer>
						{/* <Box className={styles.container}>
							<RouterProvider router={router} />
						</Box> */}
					</Box>
					<ToastContainer
						theme="dark"
						position="bottom-right"
						style={{
							marginBottom: "150px",
						}}
					/>
				</Theme>
			</StrictMode>
		</>
	);
}

export default App;
