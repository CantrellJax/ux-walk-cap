const MAX_JSON_BYTES = 24 * 1024 * 1024;

async function gunzipJson(response) {
	const reader = response.body
		.pipeThrough(new DecompressionStream("gzip"))
		.getReader();
	const chunks = [];
	let size = 0;
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > MAX_JSON_BYTES) {
			await reader.cancel();
			throw new Error("This rewind is too large to open.");
		}
		chunks.push(value);
	}
	return JSON.parse(await new Blob(chunks).text());
}

function describe(report, recording) {
	const details = document.getElementById("details");
	const rows = [
		["Site", report.site],
		["Sent", new Date(report.createdAt).toLocaleString()],
		["Page", report.evidence?.route ?? ""],
		[
			"Rewind",
			`${Math.round((recording.endedAt - recording.startedAt) / 1000)} s, from ${new Date(recording.startedAt).toLocaleTimeString()}`,
		],
		["Note", report.note || "(none)"],
	];
	details.replaceChildren(
		...rows.flatMap(([term, value]) => {
			const dt = document.createElement("dt");
			dt.textContent = term;
			const dd = document.createElement("dd");
			dd.textContent = value;
			return [dt, dd];
		}),
	);
	details.hidden = false;
}

function play(recording) {
	const events = recording.events;
	const meta = events.find((event) => event.type === 4)?.data ?? {};
	const target = document.getElementById("player");
	const width = Math.max(280, Math.min(target.clientWidth || 960, 1200));
	const ratio = meta.width && meta.height ? meta.height / meta.width : 0.625;
	const height = Math.round(
		Math.min(width * ratio, Math.max(240, window.innerHeight - 160)),
	);
	const Player =
		typeof window.rrwebPlayer === "function"
			? window.rrwebPlayer
			: window.rrwebPlayer?.default;
	if (!Player) throw new Error("The replay player did not load.");
	target.replaceChildren();
	new Player({
		target,
		props: { events, width, height, autoPlay: false, mouseTail: true },
	});
}

async function open(credential) {
	const id = location.pathname.split("/").at(-1);
	const base = `/api/v1/feedback/${id}`;
	const init = {
		headers: { Authorization: `Bearer ${credential}` },
		credentials: "omit",
		cache: "no-store",
	};
	const report = await fetch(base, init);
	if (report.status === 401)
		throw new Error("That credential was not accepted.");
	if (!report.ok)
		throw new Error("This report was deleted, has expired or does not exist.");
	const rewind = await fetch(`${base}/rewind`, init);
	if (!rewind.ok) throw new Error("This report has no rewind.");
	const recording = await gunzipJson(rewind);
	if (
		recording?.schemaVersion !== 1 ||
		recording.kind !== "rrweb" ||
		!Array.isArray(recording.events)
	)
		throw new Error("This rewind could not be read.");
	const value = await report.json();
	describe(value, recording);
	play(recording);
}

document.getElementById("unlock").addEventListener("submit", (event) => {
	event.preventDefault();
	const input = document.getElementById("credential");
	const credential = input.value.trim();
	input.value = "";
	const status = document.getElementById("status");
	status.textContent = "Opening the rewind…";
	open(credential)
		.then(() => {
			document.getElementById("unlock").hidden = true;
			status.textContent =
				"Replay of the last minutes before this report was sent.";
		})
		.catch((error) => {
			status.textContent = error.message;
		});
});
