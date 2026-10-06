import { cubicBezier } from "framer-motion";

export type InfoPose = {
	left: number;
	top: number;
	width: number;
	height: number;
	fontSize: number;
	lineHeight: number;
	lighten: number;
};

export type Animate = (
	element: Element,
	keyframes: Keyframe[],
	options?: KeyframeAnimationOptions,
) => Animation;

const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const returnHorizontalEase = cubicBezier(0.25, 0.1, 0.25, 1);

/** 只测量一次，之后由浏览器沿采样得到的时间曲线移动现有的文字元素 */
export function createInfoMotion(
	source: HTMLDivElement,
	slot: HTMLDivElement,
	destination: HTMLDivElement,
	page: HTMLDivElement,
	opening: boolean,
	previous: InfoPose | null,
) {
	// 全屏控件以 plus-lighter 方式与歌词背景叠加混合。popover 会脱离这些祖先元素，
	// 因此在普通文字上方叠一份同样混合的副本，并在两者之间交叉淡入淡出
	let fullLighten = 0;
	for (
		let node: HTMLElement | null = destination;
		node !== page && node;
		node = node.parentElement
	) {
		if (getComputedStyle(node).mixBlendMode === "plus-lighter") {
			fullLighten = 1;
			break;
		}
	}
	const measure = (node: HTMLElement, full = false): InfoPose => {
		const rect = node.getBoundingClientRect();
		const style = getComputedStyle(node);
		return {
			left: rect.left,
			top: rect.top - (full ? page.getBoundingClientRect().top : 0),
			width: rect.width,
			height: rect.height,
			fontSize: Number.parseFloat(style.fontSize),
			lineHeight: Number.parseFloat(style.lineHeight),
			lighten: full ? fullLighten : 0,
		};
	};
	const compact = () => measure(slot);
	const full = () => measure(destination, true);
	const name = source.firstElementChild;
	const fullName = destination.firstElementChild;
	if (
		!name ||
		!fullName ||
		name.textContent !== fullName.textContent ||
		full().height === 0
	)
		return;
	// 过渡期间文字由本动画接管。将歌词库的延迟滑入固定在终点，
	// 避免它在共享文字交接时仍在下方继续移动
	const owner = destination.parentElement;
	const previousOwner = owner?.getAttribute("data-player-info-motion");
	owner?.setAttribute("data-player-info-motion", "");
	const start = previous ?? (opening ? compact() : full());
	const target = opening ? full() : compact();
	const visibility = destination.style.visibility;
	destination.style.visibility = "hidden";
	source.setAttribute("popover", "manual");
	source.showPopover();
	source.style.left = "0px";
	source.style.top = "0px";
	const lightText =
		fullLighten || start.lighten
			? (source.cloneNode(true) as HTMLDivElement)
			: null;
	if (lightText) {
		lightText.removeAttribute("id");
		lightText.inert = true;
		lightText.style.mixBlendMode = "plus-lighter";
		source.after(lightText);
		lightText.showPopover();
	}
	// 跟踪过渡期间到达的歌曲信息更新，即使封面没有变化也要同步
	const textObserver = lightText
		? new MutationObserver(() => {
				lightText.replaceChildren(
					...Array.from(source.childNodes, (node) => node.cloneNode(true)),
				);
			})
		: null;
	textObserver?.observe(source, {
		childList: true,
		characterData: true,
		subtree: true,
	});

	return {
		play(animate: Animate, ease: (t: number) => number, isVertical: boolean) {
			const frames: Keyframe[] = [];
			// 竖屏文字在两个端点之间沿用封面的缓动。
			// 只有横屏布局需要采样时间曲线，让文字避开封面
			const steps = isVertical ? 1 : 60;
			for (let i = 0; i <= steps; i++) {
				const elapsed = i / steps;
				const fraction = ease(elapsed);
				const horizontal = opening
					? fraction * fraction
					: returnHorizontalEase(elapsed);
				const vertical = opening
					? fraction * fraction
					: 1 - (1 - fraction) * (1 - fraction);
				frames.push({
					offset: elapsed,
					transform: `translate(${mix(start.left, target.left, horizontal)}px, ${mix(start.top, target.top, vertical)}px)`,
					width: `${mix(start.width, target.width, horizontal)}px`,
					height: `${mix(start.height, target.height, horizontal)}px`,
					fontSize: `${mix(start.fontSize, target.fontSize, horizontal)}px`,
					lineHeight: `${mix(start.lineHeight, target.lineHeight, horizontal)}px`,
				});
			}
			animate(source, frames, isVertical ? {} : { easing: "linear" });
			if (lightText) {
				animate(lightText, frames, isVertical ? {} : { easing: "linear" });
				animate(source, [
					{ opacity: 1 - start.lighten },
					{ opacity: 1 - target.lighten },
				]);
				animate(lightText, [
					{ opacity: start.lighten },
					{ opacity: target.lighten },
				]);
			}
		},
		capture: () => ({
			...measure(source),
			lighten: lightText
				? Number.parseFloat(getComputedStyle(lightText).opacity)
				: 0,
		}),
		readTarget: () => (opening ? full() : compact()),
		restore() {
			// hidePopover 期间保持最终姿态，控制器会在绘制前取消动画
			textObserver?.disconnect();
			if (source.matches(":popover-open")) source.hidePopover();
			lightText?.remove();
			source.removeAttribute("popover");
			source.style.removeProperty("left");
			source.style.removeProperty("top");
			destination.style.visibility = visibility;
			if (previousOwner == null)
				owner?.removeAttribute("data-player-info-motion");
			else owner?.setAttribute("data-player-info-motion", previousOwner);
		},
	};
}
