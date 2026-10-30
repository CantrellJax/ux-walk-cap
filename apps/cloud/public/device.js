import { authClient } from "/app/auth-client.js";

const status = document.getElementById("status");
const lookup = document.getElementById("lookup");
const review = document.getElementById("review");
const input = document.getElementById("code");
const names = {
	"cap-ux-desktop": "Cap UX desktop",
	"cap-ux-cli": "Cap UX CLI",
};
let userCode = "";

function show(message) {
	status.textContent = message;
}

async function check(code) {
	userCode = code
		.trim()
		.toUpperCase()
		.replace(/[^A-Z0-9]/g, "");
	const result = await authClient.device({ query: { user_code: userCode } });
	if (result.error) {
		show(result.error.error_description ?? "That code is invalid or expired.");
		return;
	}
	if (result.data.status !== "pending") {
		show(`This request was already ${result.data.status}.`);
		return;
	}
	lookup.hidden = true;
	review.hidden = false;
	document.getElementById("request").textContent =
		`${names[result.data.client_id] ?? "An app"} is asking to use your account with code ${userCode}.`;
	show("Approve only if you started this request.");
}

async function decide(approved) {
	const result = approved
		? await authClient.device.approve({ userCode })
		: await authClient.device.deny({ userCode });
	review.hidden = true;
	if (result.error)
		show(
			result.error.error_description ?? "That request could not be updated.",
		);
	else
		show(
			approved
				? "Approved. Return to Cap UX to finish connecting."
				: "Denied. The app will not get access.",
		);
}

async function start() {
	const session = await authClient.getSession();
	const code = new URLSearchParams(location.search).get("user_code") ?? "";
	if (!session.data) {
		const next = `/device${code ? `?user_code=${encodeURIComponent(code)}` : ""}`;
		location.replace(`/signin?next=${encodeURIComponent(next)}`);
		return;
	}
	lookup.addEventListener("submit", (event) => {
		event.preventDefault();
		check(input.value);
	});
	document
		.getElementById("approve")
		.addEventListener("click", () => decide(true));
	document
		.getElementById("deny")
		.addEventListener("click", () => decide(false));
	if (code) {
		input.value = code;
		await check(code);
	}
}

start().catch(() => show("Device approval is unavailable right now."));
