import { useAuth, useConvexClient } from "convex-svelte";
import { createConvexHttpClient } from "convex-svelte/sveltekit";
import type { ConvexClient } from "convex/browser";
import { getFunctionName, type FunctionReference, type FunctionReturnType } from "convex/server";
import { convexToJson } from "convex/values";
import { hydratable, tick, untrack } from "svelte";
import { browser } from "$app/environment";
import { navigating, page } from "$app/state";
import { cacheResource } from "./cache.svelte.js";
import { getConvexQueryContext } from "./context.js";

/**
 * Runs a query once, over the browser's connection or over HTTP while server rendering.
 * A server render embeds the result in the page so hydration reuses it instead of waiting
 * on the browser's connection. For a failed query it embeds only that it failed, so the browser
 * runs it again.
 */
export async function queryOnce<Query extends FunctionReference<"query", "public">>(
	client: ConvexClient,
	query: Query,
	args: Query["_args"],
): Promise<FunctionReturnType<Query>> {
	const run = (): Promise<FunctionReturnType<Query>> =>
		browser ? client.query(query, args) : createConvexHttpClient().query(query, args);

	type Embedded = { ok: true; value: FunctionReturnType<Query> } | { ok: false };
	const key = `convex:${generateCacheKey(query, args)}`;
	let request: Promise<FunctionReturnType<Query>> | undefined;
	const embedded = await (browser
		? takeEmbedded<Embedded>(key)
		: hydratable(key, () => {
				request = run();
				return request.then(
					(value): Embedded => ({ ok: true, value }),
					(): Embedded => ({ ok: false }),
				);
			}));
	return embedded?.ok ? embedded.value : await (request ?? run());
}

/**
 * Svelte's `hydratable` only finds embedded values while it hydrates synchronously, so a query
 * first read after an `await` in a component's script would miss the server's result and fetch
 * it again while the page hydrates. In dev it also throws while hydrating for a query the server
 * didn't run, and the server only runs the queries its render awaits. Read the embedded value
 * directly instead. Each is used once, so the same query later on still fetches current data.
 */
function takeEmbedded<T>(key: string): Promise<T> | undefined {
	const store = (window as { __svelte?: { h?: Map<string, Promise<T>> } }).__svelte?.h;
	const value = store?.get(key);
	store?.delete(key);
	return value;
}

export type MissingArgReport = {
	query: string;
	undefinedArgs: string[];
	route: string | null;
	navigatingFrom: string | null;
	navigatingTo: string | null;
	navigationType: string | null;
	convexAuthenticated: boolean | null;
};

/**
 * Reports a query that fails after being called with an undefined argument, along with the route
 * and navigation it was made during. Queries whose optional arguments are undefined succeed, so
 * they don't report.
 */
export function missingArgReporter(
	query: FunctionReference<"query", "public">,
	args: Record<string, unknown>,
	onMissingArg: ((report: MissingArgReport) => void) | undefined,
) {
	const undefinedArgs = Object.keys(args).filter((key) => args[key] === undefined);
	if (!browser || !onMissingArg || undefinedArgs.length === 0) return undefined;

	const madeDuring = untrack(() => ({
		route: page.route.id,
		navigatingFrom: navigating.from?.route.id ?? null,
		navigatingTo: navigating.to?.route.id ?? null,
		navigationType: navigating.type ?? null,
		convexAuthenticated: convexAuthenticated(),
	}));
	let reported = false;
	return () => {
		if (reported) return;
		reported = true;
		onMissingArg({ query: getFunctionName(query), undefinedArgs, ...madeDuring });
	};
}

function convexAuthenticated() {
	try {
		return useAuth().isAuthenticated;
	} catch {
		// Only apps that set up Convex auth have it
		return null;
	}
}

/**
 * A live Convex query that can be awaited. Awaiting it resolves with its first result, and
 * `current` follows every update after that.
 */
export class ConvexQuery<
	Query extends FunctionReference<"query", "public">,
	QueryResult = Query["_returnType"],
> {
	unsubscribe: (() => void) | undefined = undefined;
	initialized = $state(false);
	#args: Query["_args"];

	#promise: Promise<QueryResult> | undefined;
	#startQuery: () => Promise<QueryResult>;
	#current: Query["_returnType"] | undefined = $state.raw(undefined);
	#error: unknown = $state.raw(undefined);

	constructor({
		query,
		args,
		onMissingArg,
	}: {
		query: Query;
		args: Query["_args"];
		onMissingArg?: (report: MissingArgReport) => void;
	}) {
		const client = useConvexClient();
		const reportMissingArg = missingArgReporter(query, args, onMissingArg);

		this.#args = args;

		// Embedded results resolve within a microtask, which can run while Svelte still has an awaiting
		// derived's context restored. Untracked writes keep that from counting as a write inside it.
		this.#startQuery = async () => {
			try {
				const result = await queryOnce(client, query, this.#args);
				untrack(() => (this.#current = result));
				return result;
			} catch (error) {
				untrack(() => (this.#error = error));
				reportMissingArg?.();
				throw error;
			} finally {
				untrack(() => (this.initialized = true));
			}
		};
		// A server render waits on every query started during it before sending the page, so on the server a
		// query starts when the render first awaits it. Queries only the browser reads, like ones under a
		// pending boundary or read in an effect, would otherwise hold back the page for nothing.
		this.#promise = $state.raw(browser ? this.#startQuery() : undefined);

		if (browser) {
			this.unsubscribe = client.onUpdate(
				query,
				this.#args,
				(result: Query["_returnType"]) => {
					// The first value is resolved by the promise
					if (!this.initialized) return;

					this.#current = result;
					this.#error = undefined;
					this.#promise = Promise.resolve(result);
				},
				async (error) => {
					this.#current = undefined;
					this.#error = error;
					this.#promise = Promise.reject(error);
					reportMissingArg?.();
				},
			);
		}
	}

	get then() {
		// A getter rather than a $derived: the cache hands this query to components other than the one
		// that created it, and a $derived owned by a destroyed component returns its stale value.
		// Only a server render starts the query here. `??=` would compile to a write even when the
		// promise exists, and async Svelte forbids writing state the render didn't just create.
		const promise = this.#promise ?? (this.#promise = this.#startQuery());

		return async (resolve: (value: QueryResult) => void, reject: (reason: unknown) => void) => {
			const result = promise.then(tick).then(() => this.#current as QueryResult);

			if (resolve || reject) {
				return result.then(resolve, reject);
			}

			return result;
		};
	}

	get current() {
		return this.#current;
	}

	get isLoading() {
		return !this.initialized;
	}

	/** Why the query failed. Awaiting it still throws; this is for reading `current` without awaiting. */
	get error() {
		return this.#error;
	}
}

export function generateCacheKey<Query extends FunctionReference<"query", "public">>(
	query: Query,
	args: Query["_args"],
) {
	let encodedArgs;
	try {
		encodedArgs = convexToJson(args);
	} catch {
		const argsTypes = Object.fromEntries(
			Object.entries(args).map(([key, value]) => [key, typeof value]),
		);
		throw new Error(`Invalid arguments for query ${getFunctionName(query)}: ${JSON.stringify(argsTypes)}`);
	}
	// Encoded, so arguments JSON can't represent (bigint, ArrayBuffer) still get a key.
	return `${getFunctionName(query)}-${JSON.stringify(encodedArgs)}`;
}

/**
 * A Convex query shared by every component reading the same query and arguments. Await it in a
 * component with async Svelte: `const jobs = $derived(await convexQuery(api.jobs.list, {}))`.
 */
export function convexQuery<Query extends FunctionReference<"query", "public">>(
	query: Query,
	args: Query["_args"],
) {
	const { queries, onMissingArg } = getConvexQueryContext();
	return cacheResource(
		queries,
		generateCacheKey(query, args),
		() => new ConvexQuery<Query>({ query, args, onMissingArg }),
		{ unsubscribe: (entry) => entry.resource.unsubscribe?.() },
	);
}
