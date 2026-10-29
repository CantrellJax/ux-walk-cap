import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

export class RecoveryTransport {
	constructor(
		origin,
		{ binary = process.env.UXW_CAP_BINARY || "cap", run = execute } = {},
	) {
		this.origin = origin;
		this.binary = binary;
		this.run = run;
	}
	async status() {
		const { stdout } = await this.run(
			this.binary,
			["recovery", "status", "--json"],
			{ timeout: 15000, maxBuffer: 65536 },
		);
		return JSON.parse(stdout);
	}
	async request(method, resource, { input, output } = {}) {
		const args = [
			"recovery",
			"request",
			"--server-origin",
			this.origin,
			"--method",
			method,
			"--resource",
			resource,
			"--json",
		];
		if (input) args.push("--input", input);
		if (output) args.push("--output", output);
		const { stdout } = await this.run(this.binary, args, {
			timeout: 45000,
			maxBuffer: 9 * 1024 * 1024,
		});
		return JSON.parse(stdout);
	}
}
