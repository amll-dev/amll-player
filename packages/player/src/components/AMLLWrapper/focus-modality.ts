const SYSTEM_KEY_PREFIX =
	/^(?:Fn|AudioVolume|Volume|Media|LaunchMedia|SelectMedia|Brightness|KeyboardBrightness)/;
const FUNCTION_KEY = /^F(?:[1-9]|1\d|2[0-4])$/;

type KeyboardModalityEvent = Pick<
	KeyboardEvent,
	"key" | "code" | "getModifierState"
>;

export function shouldPreservePointerFocusMode(
	event: KeyboardModalityEvent,
): boolean {
	return (
		event.getModifierState("Fn") ||
		event.key === "Unidentified" ||
		FUNCTION_KEY.test(event.key) ||
		FUNCTION_KEY.test(event.code) ||
		SYSTEM_KEY_PREFIX.test(event.key) ||
		SYSTEM_KEY_PREFIX.test(event.code)
	);
}
