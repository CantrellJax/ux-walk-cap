(() => {
	if (globalThis.__capUXMeetCompanion) return;
	globalThis.__capUXMeetCompanion = true;
	let binding = null,
		recording = false,
		epoch = null,
		clickedCaptions = false,
		observer = null,
		timer = 0,
		nextId = 1;
	let lastNames = "",
		lastNamesAt = 0;
	const ids = new WeakMap(),
		sent = new Map();
	const region = () =>
		[...document.querySelectorAll('div[role="region"][tabindex="0"]')].find(
			(el) => /aption/i.test(el.getAttribute("aria-label") || ""),
		) ||
		document.querySelector(
			'[jsname="dsyhDe"] div[role="region"], .vNKgIf.UDinHf',
		);
	function read(block) {
		if (
			block.matches("button, .IMKgW") ||
			block.querySelector(":scope > .GvZY2")
		)
			return null;
		const nameEl = block.querySelector(
			".NWpY1d, .KcIKyf span, .zs7s8d, img + div span, img ~ div span",
		);
		const textEl =
			block.querySelector('.ygicle, .VbkSUe, .bh44bd, [jsname="tgaKEf"]') ||
			block.lastElementChild;
		const name = (nameEl?.textContent || "").trim().slice(0, 128),
			text = (textEl && textEl !== nameEl ? textEl.textContent : "").trim();
		return name && text
			? { name, text: text.slice(0, 8000), truncated: text.length > 8000 }
			: null;
	}
	function enabled(value) {
		document.dispatchEvent(
			new CustomEvent("uxw-companion-captions", { detail: value }),
		);
	}
	function send(data) {
		if (!recording || !binding) return;
		chrome.runtime
			.sendMessage({
				type: "companion-observed",
				role: "meet",
				bindingId: binding.bindingId,
				clockEpoch: epoch,
				data: { ...data, observedAt: Date.now() },
			})
			.then((reply) => {
				if (reply?.ok === false) onState({ recording: false });
			})
			.catch(() => onState({ recording: false }));
	}
	function scan(prime = false) {
		const root = region();
		if (!root || (!recording && !prime)) return;
		for (const block of [...root.children].slice(-128)) {
			const caption = read(block);
			if (!caption) continue;
			if (!ids.has(block)) ids.set(block, nextId++);
			const id = String(ids.get(block)),
				old = sent.get(id);
			if (old?.text === caption.text && old?.name === caption.name) continue;
			const revision = (old?.revision ?? 0) + 1;
			sent.set(id, { ...caption, revision });
			while (sent.size > 2048) sent.delete(sent.keys().next().value);
			if (!prime)
				send({
					kind: "caption",
					captionId: id,
					revision,
					...caption,
					localSpeaker: /^you$/i.test(caption.name),
				});
		}
	}
	function watch() {
		const root = region();
		if (!root || observer?.target === root) return;
		observer?.disconnect();
		observer = new MutationObserver(() => {
			if (!timer)
				timer = setTimeout(() => {
					timer = 0;
					scan();
				}, 300);
		});
		observer.target = root;
		observer.observe(root, {
			childList: true,
			subtree: true,
			characterData: true,
		});
	}
	function captionsState() {
		const icons = [
			...document.querySelectorAll(
				"button i.google-symbols, button i.material-icons-extended",
			),
		].map((el) => el.textContent.trim());
		if (
			icons.includes("closed_caption_off") ||
			document.querySelector('button[aria-label="Turn on captions"]')
		)
			return "off";
		if (
			icons.includes("closed_caption") ||
			document.querySelector('button[aria-label="Turn off captions"]')
		)
			return "on";
		return "unknown";
	}
	function turnOn() {
		if (clickedCaptions) return;
		const icon = [
			...document.querySelectorAll(
				"button i.google-symbols, button i.material-icons-extended",
			),
		].find((el) => el.textContent.trim() === "closed_caption_off");
		const button =
			icon?.closest("button") ||
			document.querySelector('button[aria-label="Turn on captions"]');
		if (button) {
			button.click();
			clickedCaptions = true;
		}
	}
	function onState(message) {
		const next = message.binding;
		if (!message.recording || !next) {
			recording = false;
			observer?.disconnect();
			observer = null;
			enabled(false);
			return;
		}
		if (!binding || binding.bindingId !== next.bindingId) {
			clickedCaptions = false;
			sent.clear();
			lastNames = "";
		}
		if (
			!recording ||
			epoch !== message.clockEpoch ||
			binding?.bindingId !== next.bindingId
		) {
			sent.clear();
			scan(true);
		}
		binding = next;
		epoch = message.clockEpoch;
		recording = true;
		enabled(true);
		turnOn();
		watch();
	}
	chrome.runtime.onMessage.addListener((message, _sender, reply) => {
		if (message.type === "companion-meet-state") {
			onState(message);
			reply({ ok: true });
		}
	});
	chrome.runtime
		.sendMessage({ type: "companion-state?" })
		.then(onState)
		.catch(() => {});
	setInterval(() => {
		if (!recording) return;
		turnOn();
		watch();
		scan();
		const names = [
			...new Set(
				[...document.querySelectorAll("[data-participant-id]")]
					.map((tile) =>
						(tile.querySelector("span.notranslate, .zWGUib")?.textContent || "")
							.trim()
							.slice(0, 128),
					)
					.filter(Boolean),
			),
		].slice(0, 64);
		const key = names.join("|");
		if (
			names.length &&
			(key !== lastNames || Date.now() - lastNamesAt > 30000)
		) {
			lastNames = key;
			lastNamesAt = Date.now();
			send({ kind: "participants", names });
		}
		send({
			kind: "health",
			captions: captionsState(),
			visible: !document.hidden,
		});
	}, 3000);
})();
