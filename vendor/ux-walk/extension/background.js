import { createCompanionController } from "./companion-controller.js";

const HOST = "com.onc4ll.uxwalk",
	pending = new Map();
let port = null;
const companion = createCompanionController({ api: chrome, callNative });
function connect() {
	if (port) return port;
	port = chrome.runtime.connectNative(HOST);
	port.onMessage.addListener((message) => {
		const waiter = pending.get(message.requestId);
		if (!waiter) return;
		clearTimeout(waiter.timer);
		pending.delete(message.requestId);
		if (message.ok === false) waiter.reject(new Error(message.error));
		else waiter.resolve(message.type === "status" ? message : message.result);
	});
	port.onDisconnect.addListener(() => {
		port = null;
		for (const waiter of pending.values()) {
			clearTimeout(waiter.timer);
			waiter.reject(new Error("Cap UX companion disconnected."));
		}
		pending.clear();
		companion.disconnected().catch(() => {});
		chrome.action.setBadgeText({ text: "?" });
		chrome.alarms.create("companion-reconnect", { when: Date.now() + 5000 });
	});
	return port;
}
function callNative(message) {
	const requestId = crypto.randomUUID();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pending.delete(requestId);
			reject(new Error("Cap UX companion timed out."));
		}, 6000);
		pending.set(requestId, { resolve, reject, timer });
		try {
			connect().postMessage({ ...message, requestId });
		} catch (error) {
			clearTimeout(timer);
			pending.delete(requestId);
			reject(error);
		}
	});
}
async function refresh() {
	const status = await companion.refresh();
	const text =
		status.connection === "disconnected"
			? "?"
			: status.state === "recording"
				? "REC"
				: status.state === "paused"
					? "Ⅱ"
					: "";
	chrome.action.setBadgeText({ text });
	chrome.action.setBadgeBackgroundColor({ color: "#303640" });
	chrome.action.setTitle({
		title: `Cap UX companion: ${status.connection === "disconnected" ? "disconnected" : status.state}`,
	});
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
	let result;
	if (
		message.type === "companion-control" &&
		sender.url === chrome.runtime.getURL("popup.html")
	)
		result = companion.control(message);
	else if (["companion-observed", "tab-observed"].includes(message.type))
		result = companion.observed(message, sender);
	else if (message.type === "companion-state?")
		result = companion.documentState(sender);
	else return false;
	result.then(reply, (error) => reply({ ok: false, error: error.message }));
	return true;
});
chrome.tabs.onRemoved.addListener((id) =>
	companion.removed(id).catch(() => {}),
);
chrome.tabs.onUpdated.addListener((id, change) =>
	companion.updated(id, change).catch(() => {}),
);
chrome.alarms.onAlarm.addListener(() => refresh().catch(() => {}));
chrome.alarms.create("companion-status", { periodInMinutes: 0.5 });
refresh().catch(() => {});
setInterval(() => refresh().catch(() => {}), 4000);
