import { passkeyClient } from "@better-auth/passkey/client";
import { createAuthClient } from "better-auth/client";
import { deviceAuthorizationClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
	baseURL: location.origin,
	basePath: "/api/auth",
	plugins: [passkeyClient(), deviceAuthorizationClient()],
});
