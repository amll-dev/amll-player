import { createRoot } from "react-dom/client";
import "@applemusic-like-lyrics/react-full/style.css";
import { TrayPlayerApp } from "./pages/tray-player/index.tsx";

createRoot(document.getElementById("root") as HTMLElement).render(
	<TrayPlayerApp />,
);
