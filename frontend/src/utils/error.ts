export function getErrorMessage(error: unknown): string {
	if (!(error instanceof Error)) {
		return String(error);
	}

	if (
		"messages" in error &&
		Array.isArray(error.messages) &&
		error.messages.length > 0
	) {
		return error.messages[error.messages.length - 1];
	}

	return error.message || "An unknown error occurred";
}
