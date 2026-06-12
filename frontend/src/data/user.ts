import { createResource } from "frappe-ui";
import type { FrappeRequestError } from "../types";

export const userResource = createResource({
	url: "meet.api.account.get_logged_in_user",
	cache: "User",
	onError(error: FrappeRequestError) {
		if (error && error.exc_type === "AuthenticationError") {
			window.location.href = "/login";
		}
	},
});
