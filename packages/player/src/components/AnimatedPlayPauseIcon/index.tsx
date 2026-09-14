import type { FC, SVGProps } from "react";
import "./style.css";

export const PLAY_ICON_PATH =
	"M7.5776,36C5.619,36 4.1567,34.6943 4,32.5008L4,5.4992C4.1567,3.3057 5.619,2 7.5776,2C8.5438,2 9.2227,2.2873 10.3195,2.8618L35.1536,15.5269C36.9293,16.4409 38,17.3287 38,19C38,20.6713 36.9293,21.5591 35.1536,22.4731L10.3195,35.1382C9.2227,35.7127 8.5438,36 7.5776,36Z";

export const PAUSE_ICON_PATH =
	"M8.7384,36C6.3594,36 5,34.5857 5,32.4261L5,5.593C5,3.4143 6.3594,2 8.7384,2L12.911,2C15.2711,2 16.6305,3.4143 16.6305,5.593L16.6305,32.4261C16.6305,34.6048 15.2711,36 12.911,36L8.7384,36ZM25.089,36C22.7289,36 21.3695,34.6048 21.3695,32.4261L21.3695,5.593C21.3695,3.4143 22.7289,2 25.089,2L29.2616,2C31.6406,2 33,3.4143 33,5.593L33,32.4261C33,34.5857 31.6406,36 29.2616,36L25.089,36Z";

export const AnimatedPlayPauseIcon: FC<
	{
		playing: boolean;
	} & SVGProps<SVGSVGElement>
> = ({ playing, ...props }) => (
	<svg
		{...props}
		data-play-pause-icon=""
		data-playing={playing ? "true" : "false"}
		aria-hidden="true"
		focusable="false"
		width="38"
		height="38"
		viewBox="0 0 38 38"
	>
		<path data-play-icon="" d={PLAY_ICON_PATH} fill="currentColor" />
		<path data-pause-icon="" d={PAUSE_ICON_PATH} fill="currentColor" />
	</svg>
);
