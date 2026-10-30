import { authClient } from "/app/auth-client.js";

const status = document.getElementById("status");
const next = new URLSearchParams(location.search).get("next");
const destination =
	next?.startsWith("/") && !next.startsWith("//") ? next : "/account";

function show(message) {
	status.textContent = message;
}

async function start() {
	const error = new URLSearchParams(location.search).get("error");
	const health = await (await fetch("/healthz")).json();
	if (!health.accounts) {
		show("Accounts are not enabled on this server.");
		document.getElementById("methods").hidden = true;
		return;
	}
	for (const provider of health.providers) {
		const button = document.getElementById(provider);
		button.hidden = false;
		button.addEventListener("click", async () => {
			const result = await authClient.signIn.social({
				provider,
				callbackURL: destination,
				errorCallbackURL: "/signin",
			});
			if (result.error) show(result.error.message ?? "Sign-in failed.");
		});
	}
	document.getElementById("signup").textContent = health.signup
		? "New accounts are created on first sign-in with GitHub or Google."
		: "New account registration is closed. Existing accounts can still sign in.";
	document.getElementById("passkey").addEventListener("click", async () => {
		const result = await authClient.signIn.passkey();
		if (result?.error) show(result.error.message ?? "Passkey sign-in failed.");
		else location.assign(destination);
	});
	const session = await authClient.getSession();
	if (session.data) location.replace(destination);
	else if (error === "signup_disabled")
		show("New account registration is closed.");
	else if (error) show("Sign-in did not complete. Try again.");
	else show("Choose how to sign in.");
}

start().catch(() => show("Sign-in is unavailable right now."));
