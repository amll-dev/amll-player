import { PlusCircledIcon } from "@radix-ui/react-icons";
import type { FC, ReactNode } from "react";

export const MusicDropVisual: FC<{
	variant: "create-playlist" | "playlist" | "playlist-detail";
	title: ReactNode;
	detail?: ReactNode;
}> = ({ variant, title, detail }) => (
	<div data-music-drop-visual={variant} aria-hidden="true">
		<div data-music-drop-visual-content="">
			<span data-music-drop-visual-icon="">
				<PlusCircledIcon />
			</span>
			<span data-music-drop-visual-copy="">
				<strong>{title}</strong>
				{detail && <small>{detail}</small>}
			</span>
		</div>
	</div>
);
