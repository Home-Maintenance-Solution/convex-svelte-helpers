import type { GenericId } from "convex/values";

export type Prettify<T> = T extends infer O ? { [K in keyof O]: O[K] } : never;

export type MaybePromise<T> = T | Promise<T>;

export type DeepPartial<T> = T extends GenericId<string>
	? T
	: T extends object
		? { [P in keyof T]?: DeepPartial<T[P]> }
		: T;

/** Every dotted path into T. Array items use a bracketed index, like `items.[0].name`. */
export type DeepKeys<T> = T extends object
	? T extends string | number | boolean | symbol | bigint | Function | Date | RegExp
		? never
		: T extends readonly (infer E)[]
			? `.[${number}].${DeepKeys<E>}`
			: {
					[K in keyof T & string]: T[K] extends readonly any[]
						? K | `${K}${DeepKeys<T[K]>}`
						: K | `${K}.${DeepKeys<T[K]>}`;
				}[keyof T & string]
	: never;

export type PathValue<T, P extends string> = P extends `${infer Key}.${infer Rest}`
	? Key extends keyof T
		? PathValue<T[Key], Rest>
		: never
	: P extends keyof T
		? T[P]
		: never;
