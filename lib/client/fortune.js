/** The single fortune toggle rendered in the session header / hero row. */
function createFortuneControl({ React, store, toggle }) {
	const h = React.createElement;

	function Control() {
		const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot);
		if (state.themeIntegrated) return null;
		const desktop = state.desktop;
		const problem = state.error || desktop?.error || (desktop?.running && desktop?.rendererReady === false ? "阿财画面尚未就绪，可从菜单栏重新加载" : "");
		const visible = desktop?.visible === true;
		const label = desktop?.running && desktop?.rendererReady === false ? "阿财画面恢复中" : visible ? "今日财运在线" : "财运正在路上";
		const disabled = state.busy || !desktop || desktop.supported === false || desktop.available === false;
		return h("button", {
			type: "button",
			className: "acai-fortune",
			onClick: toggle,
			disabled,
			"data-acai-fortune": visible ? "online" : "away",
			"aria-pressed": visible,
			"aria-busy": state.busy,
			title: problem || (desktop?.supported === false ? "阿财桌面宠物需要 macOS 13+" : desktop?.available === false ? "原生程序缺失，请重新安装阿财插件" : visible ? "点击收起阿财" : "点击唤回阿财")
		}, h("span", { className: "acai-fortune__dot", "aria-hidden": true }), label);
	}

	return Control;
}

module.exports = { createFortuneControl };
