/** Bridge one click on the theme's merit badge to a pet coin animation. */
function createMeritListener({ document, animate }) {
	if (typeof document === "undefined" || typeof document.addEventListener !== "function") return () => {};
	const onClick = (event) => {
		const target = event.target;
		if (!target || typeof target.closest !== "function" || !target.closest(".caishen-merit")) return;
		void animate("coin");
	};
	document.addEventListener("click", onClick);
	return () => document.removeEventListener("click", onClick);
}

module.exports = { createMeritListener };
