const invokedTab = chrome.tabs
	.query({ active: true, currentWindow: true })
	.then((tabs) => tabs[0]);
const buttons = [...document.querySelectorAll("button")],
	statusEl = document.getElementById("status"),
	errorEl = document.getElementById("error");
const time = (ms) =>
	`${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
const recent = (timestamp) =>
	Number.isSafeInteger(timestamp) &&
	timestamp >= 0 &&
	Date.now() - timestamp >= -1000 &&
	Date.now() - timestamp <= 15000;
let busy = false;
async function act(action = "status", role) {
	if (busy) return;
	busy = true;
	buttons.forEach((button) => {
		button.disabled = true;
	});
	try {
		const tab = await invokedTab;
		const state = await chrome.runtime.sendMessage({
			type: "companion-control",
			action,
			role,
			tabId: tab?.id,
			windowId: tab?.windowId,
		});
		statusEl.textContent =
			state.connection === "disconnected"
				? "Disconnected from Cap UX"
				: {
						recording: "Recording in Cap UX",
						paused: "Paused in Cap UX",
						preparing: "Preparing recording",
						finishing: "Finishing recording",
						legacy: "Restart the updated recorder to connect",
						idle: "Ready — start a recording in Cap UX",
					}[state.state] || "Cap UX unavailable";
		errorEl.textContent = state.error || state.lastError || "";
		for (const roleName of ["walkthrough", "meet"])
			document.getElementById(roleName).textContent =
				state.roles?.[roleName]?.title ||
				state.roles?.[roleName]?.url ||
				(roleName === "meet" ? "No meeting selected" : "No tab selected");
		for (const button of buttons) {
			const selected = state.roles?.[button.dataset.role];
			button.disabled =
				button.dataset.action === "attach"
					? !state.recording ||
						!!selected ||
						(button.dataset.role === "meet" &&
							!tab?.url?.startsWith("https://meet.google.com/"))
					: button.dataset.action === "checkpoint"
						? !state.recording || !selected
						: !selected;
		}
		const meet = state.meet;
		document.getElementById("captions").textContent = meet?.lastCaptionAt
			? `Last caption ${Math.max(0, Math.floor((Date.now() - meet.lastCaptionAt) / 1000))}s ago. Names remain unconfirmed.`
			: "No captions received yet. Turn captions on in the selected Meet tab.";
		const backup = state.backup;
		const connected = state.connection === "connected";
		const audio = state.audio;
		const audioChoice = (kind) =>
			connected &&
			recent(audio?.updatedAt) &&
			["on", "off"].includes(audio[kind])
				? audio[kind]
				: "unconfirmed";
		const computerAudio = audioChoice("systemAudio");
		document.getElementById("audio").textContent =
			`Mic: ${audioChoice("microphone")} · Computer audio: ${computerAudio}. Selected in Cap UX; sound and mute status aren’t verified here.${state.roles?.meet && computerAudio === "off" ? " Meet speech is not captured through computer audio. Captions can still save." : ""}`;
		const eventLabels = {
			current: "current at last check",
			waiting: "waiting for backup",
			none: "none saved yet",
			unconfirmed: "unconfirmed",
		};
		const audioLabels = {
			current: "current at last check",
			waiting: "waiting for backup",
			"not-selected": "not selected",
			attention: "needs attention",
			unconfirmed: "unconfirmed",
		};
		let backupText = "Private backup is unconfirmed. Check Cap UX.";
		if (connected && recent(backup?.updatedAt)) {
			if (backup.enabled === false) backupText = "Private backup is off.";
			else if (backup.enabled === true) {
				const notes =
					Number.isSafeInteger(backup.journalThroughMs) &&
					backup.journalThroughMs > 0
						? `Notes backed up through ${time(backup.journalThroughMs)}.`
						: "Notes backup is waiting for confirmation.";
				backupText = `${backup.needsAttention ? "Private backup needs attention. Check Cap UX. " : ""}${notes} Tab and Meet evidence: ${eventLabels[state.queued ? "waiting" : backup.eventState] || "unconfirmed"}. Saved audio: ${audioLabels[backup.audioState] || "unconfirmed"}.`;
			}
		}
		document.getElementById("backup").textContent =
			`${state.queued ? `${state.queued} observations queued in Chrome. ` : ""}${backupText}`;
	} catch (error) {
		statusEl.textContent = "Cap UX companion unavailable";
		errorEl.textContent = `${error.message} In Cap UX settings, choose Set up browser companion.`;
		document.getElementById("audio").textContent =
			"Mic: unconfirmed · Computer audio: unconfirmed.";
		document.getElementById("backup").textContent =
			"Private backup is unconfirmed. Check Cap UX.";
	} finally {
		busy = false;
	}
}
for (const button of buttons)
	button.addEventListener("click", () =>
		act(button.dataset.action, button.dataset.role),
	);
act();
setInterval(() => act(), 3000);
