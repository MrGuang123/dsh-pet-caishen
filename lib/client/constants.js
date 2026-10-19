/** Shared wire and integration constants for the DSH browser adapter. */
const ENDPOINT = "/pet-caishen/bridge";
const HEADERS = { "X-Acai-Client": "dsh-plugin-v1", "Content-Type": "application/json" };
const PROVIDER = "__DSH_ACAI_COMPANION_V1__";
const STATUS_EVENT = "dsh-pet-caishen:status";
const THEME_EVENT = "dsh-theme-caishen:status-host";
const FORTUNE_STYLE_ID = "dsh-pet-caishen:fortune";
const THEME_STATUS_STYLE_ID = "dsh-pet-caishen:fortune-status";

module.exports = {
	ENDPOINT,
	HEADERS,
	PROVIDER,
	STATUS_EVENT,
	THEME_EVENT,
	FORTUNE_STYLE_ID,
	THEME_STATUS_STYLE_ID
};
