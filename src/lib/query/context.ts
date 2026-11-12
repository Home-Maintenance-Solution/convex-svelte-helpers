import { createContext } from "svelte";
import type { Cache } from "./cache.svelte.js";
import type { ConvexQuery, MissingArgReport } from "./convex-query.svelte.js";
import type { PaginatedConvexQuery } from "./paginated-convex-query.svelte.js";

export type ConvexQueryOptions = {
	/**
	 * Called when a query fails after being called with an undefined argument. A page can render
	 * with another route's params while a navigation is pending, which leaves the ids it reads from
	 * them undefined. Report it to your error tracking to find those pages.
	 */
	onMissingArg?: (report: MissingArgReport) => void;
};

type ConvexQueryContext = ConvexQueryOptions & {
	queries: Cache<ConvexQuery<any, any>>;
	paginatedQueries: Cache<PaginatedConvexQuery<any, any>>;
};

export const [getConvexQueryContext, setConvexQueryContext] = createContext<ConvexQueryContext>();

/**
 * Call once in the root layout, after `setupConvex`. Every query is shared through this
 * layout's caches.
 */
export function setupConvexQueries(options: ConvexQueryOptions = {}) {
	setConvexQueryContext({ ...options, queries: new Map(), paginatedQueries: new Map() });
}
