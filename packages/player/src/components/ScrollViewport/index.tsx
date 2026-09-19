import { type ComponentPropsWithoutRef, forwardRef } from "react";

/** Native scrolling only: refs and events target this element, with no resize observers. */
export const ScrollViewport = forwardRef<
	HTMLDivElement,
	ComponentPropsWithoutRef<"div"> & { horizontal?: boolean; bleed?: boolean }
>(({ horizontal = false, bleed = false, ...props }, ref) => (
	<div
		{...props}
		ref={ref}
		data-amll-scroll-viewport=""
		data-amll-scroll-horizontal={horizontal ? "" : undefined}
		data-amll-scroll-bleed={bleed ? "" : undefined}
	/>
));

ScrollViewport.displayName = "ScrollViewport";
