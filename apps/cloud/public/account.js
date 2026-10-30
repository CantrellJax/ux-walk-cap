import { authClient } from "/app/auth-client.js";

const status = document.getElementById("status");

function show(message) {
	status.textContent = message;
}

function bytes(value) {
	const units = ["B", "KB", "MB", "GB", "TB"];
	let size = value;
	let unit = 0;
	while (size >= 1024 && unit < units.length - 1) {
		size /= 1024;
		unit += 1;
	}
	return `${size.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

async function start() {
	const response = await fetch("/api/v1/me", { credentials: "same-origin" });
	if (response.status === 401) {
		location.replace("/signin?next=/account");
		return;
	}
	if (!response.ok) throw new Error();
	const me = await response.json();
	document.getElementById("identity").textContent =
		`${me.user.name || me.user.email} · ${me.user.email} · ${me.plan} plan`;
	document.getElementById("usage").textContent =
		`${bytes(me.usage.storedBytes)} of ${bytes(me.quota.maxStoredBytes)} stored · ${me.usage.activeShares} of ${me.quota.maxActiveShares} active shares`;
	show("Signed in.");
	document.getElementById("passkey").addEventListener("click", async () => {
		const result = await authClient.passkey.addPasskey();
		show(
			result?.error
				? (result.error.message ?? "Passkey was not added.")
				: "Passkey added.",
		);
	});
	document.getElementById("export").addEventListener("click", async () => {
		const result = await fetch("/api/v1/me/export", {
			credentials: "same-origin",
		});
		if (!result.ok) return show("Export failed. Try again.");
		const link = document.createElement("a");
		link.href = URL.createObjectURL(await result.blob());
		link.download = "cap-ux-account.json";
		link.click();
		URL.revokeObjectURL(link.href);
	});
	document.getElementById("signout").addEventListener("click", async () => {
		await authClient.signOut();
		location.assign("/signin");
	});
	document
		.getElementById("delete")
		.addEventListener("submit", async (event) => {
			event.preventDefault();
			if (document.getElementById("confirm").value !== "DELETE")
				return show("Type DELETE to confirm account deletion.");
			const result = await fetch("/api/v1/me", {
				method: "DELETE",
				credentials: "same-origin",
			});
			if (result.ok) {
				location.assign("/");
				return;
			}
			const body = await result.json().catch(() => ({}));
			show(
				body.code === "SESSION_EXPIRED"
					? "For your security, sign in again before deleting your account."
					: (body.message ?? body.error ?? "Account deletion failed."),
			);
		});
}

start().catch(() => show("Your account is unavailable right now."));
