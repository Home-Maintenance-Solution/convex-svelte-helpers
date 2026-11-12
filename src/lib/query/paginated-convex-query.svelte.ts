import type { FunctionReference, FunctionReturnType, paginationOptsValidator } from "convex/server";
import type { ConvexClient } from "convex/browser";
import { useConvexClient } from "convex-svelte";
import { tick } from "svelte";
import type { Attachment } from "svelte/attachments";
import { cacheResource } from "./cache.svelte.js";
import { getConvexQueryContext } from "./context.js";
import { generateCacheKey, missingArgReporter, queryOnce, type MissingArgReport } from "./convex-query.svelte.js";

type PaginatedConvexQueryOptions = {
	initialQueryItemNumber: number;
};

/**
 * A live paginated Convex query that can be awaited. Awaiting it resolves with the loaded results,
 * and `loadMore` or `intersectionObserverAttachment` loads further pages.
 */
export class PaginatedConvexQuery<
	TQuery extends FunctionReference<"query", "public">,
	TQueryArgs extends Omit<TQuery["_args"], typeof paginationOptsValidator.fieldPaths>,
> {
	#queries = $state<(NonNullable<FunctionReturnType<TQuery>> & { unsubscribe: () => void })[]>([]);
	#isLoading = $state(false);
	#error = $state.raw<Error>();
	#disposed = false;
	#initialQueryPending = true;
	#convexClient: ConvexClient;
	#queryFn: TQuery;
	#queryArgs: TQueryArgs;
	#reportMissingArg: (() => void) | undefined;
	#resultPromise: Promise<TQuery["_returnType"]["page"]>;

	#options: PaginatedConvexQueryOptions;

	constructor(
		query: TQuery,
		queryArgs: TQueryArgs,
		options?: Partial<PaginatedConvexQueryOptions> & {
			onMissingArg?: (report: MissingArgReport) => void;
		},
	) {
		this.#convexClient = useConvexClient();
		this.#queryFn = query;
		this.#queryArgs = queryArgs;
		this.#reportMissingArg = missingArgReporter(query, queryArgs, options?.onMissingArg);

		this.#options = {
			initialQueryItemNumber: options?.initialQueryItemNumber ?? 15,
		};

		// Request the first page during construction so a server render embeds it for hydration.
		// Apply it outside the constructor's reactive tracking context.
		const firstPage = this.#queryPage(this.#pageArgs(undefined, this.#options.initialQueryItemNumber));
		void firstPage.catch(() => {});
		this.#resultPromise = $state.raw(
			Promise.resolve()
				.then(() => this.#loadPage(this.#options.initialQueryItemNumber, firstPage))
				.then(() => this.results)
				.finally(() => {
					this.#initialQueryPending = false;
				}),
		);
		// The query may fail before a consumer awaits it; keep its rejection available to await.
		void this.#resultPromise.catch(() => {});
	}

	unsubscribe() {
		this.#disposed = true;
		this.#queries.forEach((query) => query.unsubscribe());
	}

	#pageArgs(cursor: string | null | undefined, numItems: number): TQuery["_args"] {
		return {
			cursor: cursor ?? null,
			numItems,
			...this.#queryArgs,
		};
	}

	#queryPage(queryArgs: TQuery["_args"]): Promise<FunctionReturnType<TQuery>> {
		return queryOnce(this.#convexClient, this.#queryFn, queryArgs);
	}

	loadMore(args: { numItems: number }) {
		return this.#loadPage(args.numItems);
	}

	async #loadPage(numItems: number, firstPage?: Promise<FunctionReturnType<TQuery>>) {
		if (this.#disposed || this.#isLoading) return false;

		this.#isLoading = true;
		try {
			await tick();
			if (this.#disposed) return false;

			const lastQuery = this.#queries.at(-1);
			if (lastQuery?.isDone) return false;

			const queryIndex = this.#queries.length;

			const queryArgs = this.#pageArgs(lastQuery?.continueCursor, numItems);

			const newQueryResult = await (firstPage ?? this.#queryPage(queryArgs)).catch((error) => {
				this.#error = error;
				this.#reportMissingArg?.();
				throw error;
			});
			if (this.#disposed) return false;
			// The next page starts where this snapshot ended, so the live page has to end there too.
			// Otherwise rows that moved since the snapshot show twice or not at all at the boundary.
			// A finished page's cursor is the end of the list, so it still shows new rows at the end.
			// Queries return an empty cursor when the user can't read them, which isn't a position.
			const liveArgs = {
				...queryArgs,
				endCursor: newQueryResult?.continueCursor || null,
			};
			const unsubscribe = this.#convexClient.onUpdate(
				this.#queryFn,
				liveArgs,
				(result) => {
					// Even the first callback can be newer than the initial query result.
					if (!result) return;
					const query = this.#queries.at(queryIndex);
					if (!query) return;
					this.#queries[queryIndex] = {
						...result,
						unsubscribe,
					};
					this.#error = undefined;
					this.#resultPromise = Promise.resolve(this.results);
				},
				(error) => {
					this.#error = error;
					this.#reportMissingArg?.();
					this.#resultPromise = Promise.reject(error);
					void this.#resultPromise.catch(() => {});
				},
			);
			if (newQueryResult) {
				this.#queries.push({
					...newQueryResult,
					unsubscribe,
				});
				if (!this.#initialQueryPending) {
					this.#resultPromise = Promise.resolve(this.results);
				}
			}

			return true;
		} finally {
			this.#isLoading = false;
		}
	}

	/** Loads `pageLength` more items whenever the element scrolls into view. */
	intersectionObserverAttachment(pageLength: number): Attachment {
		return (element) => {
			if (this.isDone) return;

			let attached = true;
			const observer = new IntersectionObserver(
				async (entries) => {
					for (const entry of entries) {
						if (!attached || this.#disposed || !entry.isIntersecting) continue;

						observer.unobserve(element);
						await this.loadMore({ numItems: pageLength });
						if (!attached || this.#disposed || this.isDone) return;
						observer.observe(element);
					}
				},
				{ threshold: 0.01 },
			);
			observer.observe(element);
			return () => {
				attached = false;
				observer.disconnect();
			};
		};
	}

	get results(): TQuery["_returnType"]["page"] {
		return this.#queries.flatMap((query) => query.page);
	}

	get then() {
		// The first page resolves this promise without invalidating its pending render.
		// Later pages and live updates replace it to update awaiting consumers.
		const promise = this.#resultPromise;
		return (resolve: (results: TQuery["_returnType"]["page"]) => void, reject: (error: unknown) => void) =>
			promise.then(resolve, reject);
	}

	get isDone() {
		return this.#queries.at(-1)?.isDone === true;
	}

	get isLoading() {
		// The first page starts loading a microtask after construction, after a server render has read this.
		return this.#isLoading || (this.#queries.length === 0 && !this.#error);
	}

	/** For consumers that read `results` instead of awaiting the query. */
	get error() {
		return this.#error;
	}
}

/**
 * A paginated Convex query shared by every component reading the same query and arguments.
 * Svelte can evaluate a $derived more than once while it settles a navigation, and sharing one
 * instance keeps every consumer on the same subscriptions.
 */
export function paginatedConvexQuery<
	TQuery extends FunctionReference<"query", "public">,
	TQueryArgs extends Omit<TQuery["_args"], typeof paginationOptsValidator.fieldPaths>,
>(query: TQuery, queryArgs: TQueryArgs, options?: Partial<PaginatedConvexQueryOptions>) {
	const { paginatedQueries, onMissingArg } = getConvexQueryContext();
	return cacheResource(
		paginatedQueries,
		`${generateCacheKey(query, queryArgs)}-${options?.initialQueryItemNumber}`,
		() => new PaginatedConvexQuery(query, queryArgs, { ...options, onMissingArg }),
		{ unsubscribe: (entry) => entry.resource.unsubscribe() },
	);
}
