import { useEffect } from "react";

export function useTitlebarAutoHide(shouldHideTitlebar: boolean) {
	useEffect(() => {
		const titlebarArea = document.getElementById("system-titlebar");
		const titlebarButtons = document.getElementById("system-titlebar-buttons");

		if (!titlebarArea || !titlebarButtons) return;

		let isHovering = false;
		let isGracePeriodOver = false;
		let timerId: ReturnType<typeof setTimeout>;

		const updateVisibility = () => {
			const shouldBeVisible =
				!shouldHideTitlebar || isHovering || !isGracePeriodOver;

			if (shouldBeVisible) {
				titlebarButtons.removeAttribute("data-hidden");
			} else {
				titlebarButtons.setAttribute("data-hidden", "true");
			}
		};

		const handleMouseEnter = () => {
			isHovering = true;
			updateVisibility();
		};

		const handleMouseLeave = () => {
			isHovering = false;
			updateVisibility();
		};

		if (shouldHideTitlebar) {
			titlebarArea.addEventListener("mouseenter", handleMouseEnter);
			titlebarArea.addEventListener("mouseleave", handleMouseLeave);

			timerId = setTimeout(() => {
				isGracePeriodOver = true;
				updateVisibility();
			}, 5000);
		}

		updateVisibility();

		return () => {
			titlebarArea.removeEventListener("mouseenter", handleMouseEnter);
			titlebarArea.removeEventListener("mouseleave", handleMouseLeave);
			clearTimeout(timerId);
			titlebarButtons.removeAttribute("data-hidden");
		};
	}, [shouldHideTitlebar]);
}
