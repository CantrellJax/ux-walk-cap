export function createCompanionController({
	api,
	callNative,
	uuid = () => crypto.randomUUID(),
}) {
	let state = { roles: {}, queue: [] },
		status = { state: "unknown", recording: false, roles: {} },
		lastError = "",
		draining = null;
	const acknowledged = new Set();
	const initialized = (async () => {
		const stored = await api.storage.local.get("companion");
		if (stored.companion && typeof stored.companion.clientId === "string")
			state = stored.companion;
		else state.clientId = uuid();
		state.roles ??= {};
		state.queue ??= [];
	})();
	const persist = () => api.storage.local.set({ companion: state });
	const bytes = (value) =>
		new TextEncoder().encode(JSON.stringify(value)).length;
	async function notify() {
		for (const [role, binding] of Object.entries(state.roles))
			await api.tabs
				.sendMessage(
					binding.tabId,
					{
						type:
							role === "meet" ? "companion-meet-state" : "companion-tab-state",
						binding,
						recording: status.recording === true,
						clockEpoch: status.clockEpoch,
						observeClicks: status.browserMode !== "owned",
					},
					{ documentId: binding.documentId },
				)
				.catch(() => {});
	}
	async function reconcile(next) {
		const previous = state.roles;
		const queuedBefore = state.queue.length;
		status = { ...next, connection: "connected" };
		state.roles = next.roles ?? {};
		state.queue = state.queue.filter(
			(item) =>
				next.recording &&
				item.recordingId === next.recordingId &&
				item.generation === next.generation &&
				item.clockEpoch === next.clockEpoch &&
				state.roles[item.role]?.bindingId === item.bindingId,
		);
		if (state.queue.length < queuedBefore) {
			state.discarded =
				(state.discarded ?? 0) + queuedBefore - state.queue.length;
			lastError =
				"Stale observations could not be saved because the recording, selected role or pause epoch changed.";
		}
		for (const [role, binding] of Object.entries(previous))
			if (
				!state.roles[role] ||
				state.roles[role].bindingId !== binding.bindingId
			)
				await api.tabs
					.sendMessage(
						binding.tabId,
						{
							type:
								role === "meet"
									? "companion-meet-state"
									: "companion-tab-state",
							recording: false,
							binding: null,
						},
						{ documentId: binding.documentId },
					)
					.catch(() => {});
		await persist();
		await notify();
	}
	async function hello() {
		await initialized;
		const next = await callNative({
			type: "companion-hello",
			clientId: state.clientId,
		});
		await reconcile(next);
		return next;
	}
	async function drain() {
		if (draining) return draining;
		draining = (async () => {
			try {
				await hello();
				while (state.queue.length && status.recording) {
					const item = state.queue[0],
						receipt = await callNative({ type: "companion-events", ...item });
					if (
						receipt?.acknowledged !== true ||
						receipt.recordingId !== item.recordingId ||
						receipt.generation !== item.generation ||
						receipt.eventIds?.length !== item.events.length ||
						receipt.eventIds.some(
							(id, index) => id !== item.events[index].eventId,
						)
					)
						throw new Error("Recorder did not acknowledge the saved evidence.");
					if (state.queue[0] === item) state.queue.shift();
					for (const id of receipt.eventIds) acknowledged.add(id);
					while (acknowledged.size > 512)
						acknowledged.delete(acknowledged.values().next().value);
					lastError = "";
					await persist();
				}
			} catch (error) {
				lastError = error.message;
				status = { ...status, recording: false, connection: "disconnected" };
				await notify();
			}
		})().finally(() => {
			draining = null;
		});
		return draining;
	}
	async function queue(binding, data) {
		const event = { ...data, eventId: uuid() },
			item = { ...binding, clockEpoch: status.clockEpoch, events: [event] };
		if (
			bytes(item) > 120 * 1024 ||
			state.queue.length >= 256 ||
			bytes([...state.queue, item]) > 256 * 1024
		)
			throw new Error(
				"Companion evidence queue is full. Reconnect Cap UX before collecting more.",
			);
		state.queue.push(item);
		await persist();
		await drain();
		return {
			ok: true,
			saved: acknowledged.has(event.eventId),
			queued: state.queue.length,
		};
	}
	const view = () => ({
		ok: true,
		...status,
		roles: state.roles,
		queued: state.queue.length,
		lastError,
	});
	return {
		async refresh() {
			await initialized;
			await drain();
			return view();
		},
		async disconnected() {
			await initialized;
			status = { ...status, recording: false, connection: "disconnected" };
			await notify();
		},
		async control(message) {
			await initialized;
			try {
				await hello();
				if (message.action === "status") {
					await drain();
					return view();
				}
				const role = message.role;
				if (!["walkthrough", "meet"].includes(role))
					throw new Error("Choose a companion role.");
				if (message.action === "detach") {
					await drain();
					const binding = state.roles[role];
					if (binding)
						await callNative({ type: "companion-detach", ...binding });
					await hello();
					return view();
				}
				if (!status.recording)
					throw new Error("Start or resume the recording in Cap UX first.");
				if (message.action === "checkpoint") {
					const binding = state.roles.walkthrough;
					if (!binding) throw new Error("Select the walkthrough tab first.");
					const reply = await api.tabs.sendMessage(
						binding.tabId,
						{ type: "companion-tab-checkpoint", bindingId: binding.bindingId },
						{ documentId: binding.documentId },
					);
					if (!reply?.ok)
						throw new Error(
							reply?.error || "Bring the selected walkthrough tab into view.",
						);
					const receipt = await queue(binding, {
						...reply.data,
						kind: "checkpoint",
					});
					return { ...view(), ...receipt };
				}
				if (message.action !== "attach")
					throw new Error("Unknown companion action.");
				if (state.roles[role])
					throw new Error("Stop this role before selecting another tab.");
				const tab = await api.tabs.get(message.tabId);
				if (
					!tab ||
					tab.windowId !== message.windowId ||
					!/^https?:\/\//.test(tab.url ?? "")
				)
					throw new Error(
						"Open the companion from the intended HTTP/HTTPS tab.",
					);
				if (
					role === "meet" &&
					new URL(tab.url).origin !== "https://meet.google.com"
				)
					throw new Error("Open the companion in the joined Meet tab.");
				const frames = await api.scripting.executeScript({
					target: { tabId: tab.id },
					files: [role === "meet" ? "content.js" : "selected-tab.js"],
				});
				const documentId = frames.find(
					(frame) => frame.frameId === 0,
				)?.documentId;
				if (!documentId)
					throw new Error("Chrome could not identify this document.");
				const binding = await callNative({
					type: "companion-attach",
					recordingId: status.recordingId,
					generation: status.generation,
					clientId: state.clientId,
					role,
					tabId: tab.id,
					windowId: tab.windowId,
					documentId,
					url: tab.url,
					title: tab.title,
				});
				state.roles[role] = binding;
				await persist();
				await notify();
				if (role === "walkthrough") {
					const ready = await api.tabs.sendMessage(
						tab.id,
						{
							type: "companion-tab-checkpoint",
							bindingId: binding.bindingId,
							observeClicks: status.browserMode !== "owned",
						},
						{ documentId },
					);
					if (!ready?.ok)
						throw new Error(
							ready?.error || "Could not observe the selected walkthrough tab.",
						);
					if (ready.data)
						await queue(binding, { ...ready.data, kind: "checkpoint" });
				}
				lastError = "";
				return view();
			} catch (error) {
				lastError = error.message;
				return { ...view(), ok: false, error: error.message };
			}
		},
		async observed(message, sender) {
			await initialized;
			try {
				const role =
						message.type === "tab-observed" ? "walkthrough" : message.role,
					binding = state.roles[role],
					url = new URL(sender.url);
				if (
					!binding ||
					!status.recording ||
					message.clockEpoch !== status.clockEpoch ||
					sender.tab?.id !== binding.tabId ||
					sender.frameId !== 0 ||
					sender.documentId !== binding.documentId ||
					message.bindingId !== binding.bindingId ||
					url.origin !== binding.origin ||
					(role === "meet" && url.pathname !== new URL(binding.url).pathname)
				)
					throw new Error(
						"Observation is outside the selected role document or pause epoch.",
					);
				return await queue(binding, message.data);
			} catch (error) {
				lastError = error.message;
				return { ok: false, error: error.message };
			}
		},
		async documentState(sender) {
			await initialized;
			const binding = Object.values(state.roles).find(
				(item) =>
					item.tabId === sender.tab?.id &&
					item.documentId === sender.documentId &&
					sender.frameId === 0 &&
					new URL(sender.url).origin === item.origin &&
					(item.role !== "meet" ||
						new URL(sender.url).pathname === new URL(item.url).pathname),
			);
			return binding
				? {
						recording: status.recording === true,
						binding,
						clockEpoch: status.clockEpoch,
						observeClicks: status.browserMode !== "owned",
					}
				: { recording: false };
		},
		async removed(tabId) {
			await initialized;
			for (const binding of Object.values(state.roles).filter(
				(item) => item.tabId === tabId,
			)) {
				try {
					await callNative({ type: "companion-detach", ...binding });
				} catch {}
				delete state.roles[binding.role];
				state.queue = state.queue.filter(
					(item) => item.bindingId !== binding.bindingId,
				);
			}
			await persist();
		},
		async updated(tabId, change) {
			if (change.status === "loading" || change.url) await this.removed(tabId);
		},
	};
}
