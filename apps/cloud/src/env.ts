export type RuntimeEnv = Omit<
	Env,
	| "BETTER_AUTH_URL"
	| "SIGNUP_ENABLED"
	| "FREE_PLAN_MAX_BYTES"
	| "FREE_PLAN_MAX_SHARES"
> & {
	UPLOAD_TOKEN?: string;
	BETTER_AUTH_URL?: string;
	BETTER_AUTH_SECRET?: string;
	SIGNUP_ENABLED?: string;
	FREE_PLAN_MAX_BYTES?: string;
	FREE_PLAN_MAX_SHARES?: string;
	GITHUB_CLIENT_ID?: string;
	GITHUB_CLIENT_SECRET?: string;
	GOOGLE_CLIENT_ID?: string;
	GOOGLE_CLIENT_SECRET?: string;
};
