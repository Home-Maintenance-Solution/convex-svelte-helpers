// Used by both the browser form and the Convex functions it submits to, so nothing here imports Svelte.
import { ConvexError } from "convex/values";
import type * as v from "valibot";

/** What a form mutation or action returns: its handler's response, or the fields that failed */
export type FormResult<TResponse> =
	| { success: true; response: TResponse }
	| { success: false; errors: { key: string; message: string }[] };

/** The issue's field as a form path. Array items use the bracketed segment `Path` expects, like `items.[0].name`. */
export function issuePath(issue: v.BaseIssue<unknown>): string {
	return (issue.path ?? [])
		.map((pathItem) => {
			if (pathItem.type === "array") return `[${String(pathItem.key)}]`;
			return pathItem.key === undefined ? undefined : String(pathItem.key);
		})
		.filter((key) => key !== undefined)
		.join(".");
}

export function errorMessage(error: unknown) {
	if (typeof error !== "object") return String(error);
	if (error === null) return "Unknown Error";
	if (error instanceof ConvexError) {
		if (typeof error.data === "object" && error.data !== null && "message" in error.data) {
			return String(error.data.message);
		}
		return String(error.data);
	}
	if ("message" in error) return String(error.message);
	return JSON.stringify(error);
}

/** The first line of an error message, without Convex's `Uncaught Error:` prefix */
export function prettyErrorMessage(message: string) {
	return (
		message
			.replace(/^(Uncaught.*Error:)/g, "")
			.split("\n")
			.at(0)
			?.trim() ?? message
	);
}
