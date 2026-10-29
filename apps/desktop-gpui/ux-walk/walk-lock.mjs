import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import {
	durableJson,
	durableMkdir,
	readJson,
	syncDirectory,
} from "./checkpoint-store.mjs";

const folders = {
	checkpoint: ".checkpoint-worker",
	processing: ".processing-lock",
};
const busy = (scope) =>
	new Error(
		scope === "processing"
			? "This walk is already being processed, or its ownership socket is busy."
			: "This recording already has a checkpoint operation, or its ownership socket is busy. Wait for evidence sync to finish.",
	);

function identity(directory, scope) {
	if (!Object.hasOwn(folders, scope))
		throw new Error("Unknown walk ownership scope");
	const canonical = fs.realpathSync(directory);
	const stat = fs.statSync(canonical, { bigint: true });
	if (!stat.isDirectory())
		throw new Error("Walk ownership requires a directory");
	const hash = createHash("sha256")
		.update(`cap-ux-walk-lock/v1:${stat.dev}:${stat.ino}:${scope}`)
		.digest();
	return { directory: canonical, hash, scope };
}

export function walkLockEndpoint(directory, scope) {
	const owned = identity(directory, scope);
	return {
		host: "127.0.0.1",
		port:
			(scope === "checkpoint" ? 40000 : 50000) +
			(owned.hash.readUInt32BE(0) % 10000),
	};
}

function liveOwner(owner) {
	if (
		!Number.isSafeInteger(owner?.pid) ||
		owner.pid < 1 ||
		owner.pid > 2147483647
	)
		return false;
	try {
		process.kill(owner.pid, 0);
		return true;
	} catch (error) {
		if (error.code === "ESRCH") return false;
		throw error;
	}
}

async function close(server) {
	if (!server.listening) return;
	await new Promise((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve())),
	);
}

export async function acquireWalkLock(directory, scope, { kind } = {}) {
	const owned = identity(directory, scope);
	const endpoint = {
		host: "127.0.0.1",
		port:
			(scope === "checkpoint" ? 40000 : 50000) +
			(owned.hash.readUInt32BE(0) % 10000),
	};
	const server = createServer((socket) => {
		socket.on("error", () => {});
		socket.destroy();
	});
	try {
		await new Promise((resolve, reject) => {
			server.once("error", reject);
			server.listen({ ...endpoint, exclusive: true }, resolve);
		});
		server.removeAllListeners("error");
	} catch (error) {
		await close(server);
		if (error.code === "EADDRINUSE") throw busy(scope);
		throw new Error(
			`Walk ownership socket is unavailable (${error.code || "unknown"}); no files were changed`,
		);
	}
	const nonce = randomUUID();
	const lock = path.join(owned.directory, folders[scope]);
	const ownerFile = path.join(lock, "owner.json");
	const anchor = path.join(lock, `guard-${nonce}.json`);
	let anchorWritten = false;
	let released = false;
	const cleanup = () => {
		if (fs.existsSync(ownerFile)) {
			let current;
			try {
				current = readJson(ownerFile);
			} catch {}
			if (current?.guardNonce === nonce && current.pid === process.pid)
				fs.unlinkSync(ownerFile);
		}
		if (anchorWritten) {
			let current;
			try {
				current = readJson(anchor);
			} catch {}
			if (current?.guardNonce === nonce) fs.unlinkSync(anchor);
		}
		if (fs.existsSync(lock)) {
			syncDirectory(lock);
			try {
				fs.rmdirSync(lock);
			} catch (error) {
				if (!["ENOTEMPTY", "EEXIST"].includes(error.code)) throw error;
			}
			syncDirectory(owned.directory);
		}
	};
	try {
		let previous = null;
		if (fs.existsSync(lock)) {
			const stat = fs.lstatSync(lock);
			if (!stat.isDirectory() || stat.isSymbolicLink())
				throw new Error("Walk ownership metadata is not an owned directory");
		}
		if (fs.existsSync(ownerFile)) {
			const stat = fs.lstatSync(ownerFile);
			if (!stat.isFile() || stat.isSymbolicLink())
				throw new Error("Walk ownership marker is not a regular file");
			if (stat.size <= 65536) {
				try {
					previous = readJson(ownerFile);
				} catch {}
			}
			const guarded =
				previous?.schemaVersion === 1 &&
				typeof previous.guardNonce === "string" &&
				previous.identity === owned.hash.toString("hex") &&
				previous.scope === scope &&
				previous.endpoint?.host === endpoint.host &&
				previous.endpoint?.port === endpoint.port;
			if (!guarded && liveOwner(previous)) throw busy(scope);
		}
		durableMkdir(lock);
		// A legacy PID reclaimer must not remove the directory after deleting owner.json.
		durableJson(anchor, { pid: process.pid, guardNonce: nonce });
		anchorWritten = true;
		if (fs.existsSync(ownerFile)) {
			const history = path.join(owned.directory, ".walk-lock-history");
			durableMkdir(history);
			fs.renameSync(ownerFile, path.join(history, `${scope}-${nonce}.json`));
			syncDirectory(history);
			syncDirectory(lock);
		}
		durableJson(ownerFile, {
			schemaVersion: 1,
			pid: process.pid,
			guardNonce: nonce,
			identity: owned.hash.toString("hex"),
			scope,
			...(kind ? { kind } : {}),
			endpoint,
		});
		return {
			async release() {
				if (released) return;
				released = true;
				try {
					cleanup();
				} finally {
					await close(server);
				}
			},
		};
	} catch (error) {
		try {
			if (anchorWritten) cleanup();
		} finally {
			await close(server);
		}
		throw error;
	}
}
