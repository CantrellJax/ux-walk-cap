import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { bearer, deviceAuthorization } from "better-auth/plugins";
import type { RuntimeEnv } from "./env";

export const NATIVE_CLIENTS = new Set(["cap-ux-desktop", "cap-ux-cli"]);

export interface AuthHooks {
	beforeDeleteUser: (userId: string) => Promise<void>;
}

export function authOptions(env: RuntimeEnv, hooks: AuthHooks) {
	const baseURL = env.BETTER_AUTH_URL ?? "http://localhost:8787";
	const signupEnabled = env.SIGNUP_ENABLED === "true";
	const socialProviders: {
		github?: { clientId: string; clientSecret: string; disableSignUp: boolean };
		google?: { clientId: string; clientSecret: string; disableSignUp: boolean };
	} = {};
	if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET)
		socialProviders.github = {
			clientId: env.GITHUB_CLIENT_ID,
			clientSecret: env.GITHUB_CLIENT_SECRET,
			disableSignUp: !signupEnabled,
		};
	if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET)
		socialProviders.google = {
			clientId: env.GOOGLE_CLIENT_ID,
			clientSecret: env.GOOGLE_CLIENT_SECRET,
			disableSignUp: !signupEnabled,
		};
	return {
		appName: "Cap UX",
		baseURL,
		basePath: "/api/auth",
		secret: env.BETTER_AUTH_SECRET,
		database: env.DB,
		trustedOrigins: [baseURL],
		telemetry: { enabled: false },
		socialProviders,
		user: {
			additionalFields: {
				plan: {
					type: "string",
					required: false,
					defaultValue: "free",
					input: false,
				},
			},
			deleteUser: {
				enabled: true,
				beforeDelete: async (user: { id: string }) =>
					hooks.beforeDeleteUser(user.id),
			},
		},
		databaseHooks: {
			user: {
				create: {
					before: async () => {
						if (!signupEnabled)
							throw new APIError("FORBIDDEN", {
								code: "SIGNUP_DISABLED",
								message: "New account registration is closed.",
							});
					},
				},
			},
		},
		rateLimit: {
			enabled: true,
			storage: "database",
			window: 60,
			max: 100,
		},
		advanced: {
			ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
		},
		plugins: [
			passkey({
				rpID: new URL(baseURL).hostname,
				rpName: "Cap UX",
				origin: baseURL,
			}),
			bearer(),
			deviceAuthorization({
				verificationUri: "/device",
				expiresIn: "10m",
				interval: "5s",
				validateClient: (clientId) => NATIVE_CLIENTS.has(clientId),
			}),
		],
	} satisfies Parameters<typeof betterAuth>[0];
}

export function createAuth(env: RuntimeEnv, hooks: AuthHooks) {
	if (!env.BETTER_AUTH_SECRET || !env.BETTER_AUTH_URL) return undefined;
	return betterAuth(authOptions(env, hooks));
}

export type Auth = NonNullable<ReturnType<typeof createAuth>>;
