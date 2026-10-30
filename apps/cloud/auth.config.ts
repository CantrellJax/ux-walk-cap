import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { betterAuth } from "better-auth";
import { authOptions } from "./src/auth";

const database = new DatabaseSync(":memory:");
const migrations = new URL("./migrations/", import.meta.url);
for (const file of readdirSync(migrations).sort())
	if (file.endsWith(".sql"))
		database.exec(readFileSync(new URL(file, migrations), "utf8"));

export const auth = betterAuth({
	...authOptions(
		{ BETTER_AUTH_URL: "https://capux.example" } as Parameters<
			typeof authOptions
		>[0],
		{ beforeDeleteUser: async () => {} },
	),
	database,
});
