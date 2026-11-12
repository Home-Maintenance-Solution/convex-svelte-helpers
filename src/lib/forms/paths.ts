import type { DeepKeys, PathValue } from "../types.js";

/** Reads a dotted path like `address.city` or `items.[0].name`, returning undefined past a missing object */
export function valueByPath<TData, TPath extends DeepKeys<TData>>(data: TData, path: TPath): PathValue<TData, TPath> {
	return path.split(".").reduce((acc: unknown, key, index, keys) => {
		if (typeof acc === "object" && acc !== null) {
			if (Array.isArray(acc)) return acc[parseInt(key.slice(1, -1))];
			return (acc as Record<string, unknown>)[key];
		}
		return index === keys.length - 1 ? undefined : {};
	}, data) as PathValue<TData, TPath>;
}

/** Writes a dotted path, creating the objects along it that don't exist yet */
export function updateByPath<TData, TPath extends DeepKeys<TData>>(
	data: TData,
	path: TPath,
	value: PathValue<TData, TPath>,
) {
	const keys = path.split(".");

	let acc = data as any;
	for (let i = 0; i < keys.length; i++) {
		let key: string | number = keys[i]!;

		if (i === keys.length - 1) {
			acc[key] = value;
			continue;
		}

		if (typeof acc !== "object" || acc === null) throw new Error("Invalid path: " + path);

		if (Array.isArray(acc)) key = parseInt(key.slice(1, -1));
		if (acc[key] === undefined) acc[key] = {};
		acc = acc[key];
	}
}
