// Runs inside Convex functions, so nothing here may import Svelte.
import type { RegisteredAction, RegisteredMutation } from "convex/server";
import { ConvexError, v as cv, type GenericId, type Validator } from "convex/values";
import * as v from "valibot";
import { errorMessage, issuePath, type FormResult } from "../shared.js";

export type { FormResult } from "../shared.js";

type AnySchema = v.BaseSchema<any, any, any>;

/** A valibot schema for a Convex document ID, which `valibotToConvex` turns into `v.id(tableName)` */
export function convexId<TTableName extends string>(tableName: TTableName, message?: string) {
	const schema = v.custom<GenericId<TTableName>>(
		(input) => typeof input === "string",
		message ?? `Please select a valid ${tableName}`,
	);
	// valibotToConvex tells it apart from other custom schemas by its type
	Object.defineProperty(schema, "type", { value: "convex_id" });
	return Object.assign(schema, { tableName });
}

/** The Convex validator matching a valibot schema, for a form function's arguments */
export function valibotToConvex(schema: AnySchema): Validator<any, any, any> {
	switch (schema.type) {
		case "object":
			return cv.object(
				Object.fromEntries(
					Object.entries((schema as v.ObjectSchema<v.ObjectEntries, any>).entries).map(([key, value]) => [
						key,
						valibotToConvex(value),
					]),
				),
			);
		case "string":
			return cv.string();
		case "convex_id":
			return cv.id((schema as ReturnType<typeof convexId>).tableName);
		case "number":
			return cv.number();
		case "boolean":
			return cv.boolean();
		case "array":
			return cv.array(valibotToConvex((schema as v.ArraySchema<AnySchema, any>).item));
		case "optional":
			return cv.optional(valibotToConvex((schema as v.OptionalSchema<AnySchema, any>).wrapped));
		case "nullable":
			return cv.union(cv.null(), valibotToConvex((schema as v.NullableSchema<AnySchema, any>).wrapped));
		case "nullish":
			return cv.optional(cv.union(cv.null(), valibotToConvex((schema as v.NullishSchema<AnySchema, any>).wrapped)));
		case "variant":
		case "union":
			return cv.union(...(schema as v.UnionSchema<AnySchema[], any>).options.map(valibotToConvex));
		case "picklist":
			return cv.union(...(schema as v.PicklistSchema<v.PicklistOptions, any>).options.map((option) => cv.literal(option)));
		case "literal":
			return cv.literal((schema as v.LiteralSchema<any, any>).literal);
		case "null":
			return cv.null();
		case "any":
			return cv.any();
		case "instance":
			if ((schema as v.InstanceSchema<any, any>).class === ArrayBuffer) return cv.bytes();
			throw new Error("Only v.instance(ArrayBuffer) can be a form field");
		default:
			throw new Error(`Unsupported valibot schema type: ${schema.type}`);
	}
}

/**
 * Throw from a form handler to show errors on the form's fields, like for a check that needs the
 * database: `throw new FormValidationError([{ path: "email", message: "That email is taken" }])`.
 */
export class FormValidationError extends ConvexError<{
	errors: { path: string; message: string }[];
	_tag: "FormValidationError";
}> {
	constructor(errors: { path: string; message: string }[]) {
		super({ errors, _tag: "FormValidationError" });
	}
}

type FormArgs<TSchema extends AnySchema> = { formData: v.InferInput<TSchema>; timezone: string };

type FormHandlerDefinition<Ctx, TSchema extends AnySchema, TReturns> = {
	schema: TSchema;
	handler: (ctx: Ctx & { timezone: string }, data: v.InferOutput<TSchema>) => TReturns;
};

/** Builds the function definition both form function kinds share, around the handler */
function formDefinition<Ctx, TSchema extends AnySchema, TReturns>({
	schema,
	handler,
}: FormHandlerDefinition<Ctx, TSchema, TReturns>) {
	return {
		args: { formData: valibotToConvex(schema), timezone: cv.string() },
		handler: async (ctx: Ctx, args: FormArgs<TSchema>): Promise<FormResult<Awaited<TReturns>>> => {
			const result = await v.safeParseAsync(schema, args.formData);
			if (!result.success) {
				return {
					success: false,
					errors: result.issues.map((issue) => ({ key: issuePath(issue), message: issue.message })),
				};
			}
			try {
				const response = await handler({ ...ctx, timezone: args.timezone }, result.output);
				return { success: true, response };
			} catch (error) {
				if (error instanceof FormValidationError) {
					return {
						success: false,
						errors: error.data.errors.map(({ path, message }) => ({ key: path, message })),
					};
				}
				if (error instanceof ConvexError) throw error;
				throw new ConvexError(errorMessage(error));
			}
		},
	};
}

/**
 * Makes a mutation builder for forms out of the project's own builder, like an authenticated one.
 * Each mutation validates its form data against the schema and answers with a `FormResult`,
 * which `createConvexForm` shows on the form's fields.
 *
 * ```ts
 * export const formMutation = createValibotMutation<AuthMutationCtx>(authMutation)
 * export const save = formMutation({ schema, handler: async (ctx, data) => { ... } })
 * ```
 */
export function createValibotMutation<Ctx>(builder: (definition: any) => unknown) {
	return <TSchema extends AnySchema, TReturns>(definition: FormHandlerDefinition<Ctx, TSchema, TReturns>) =>
		builder(formDefinition(definition)) as RegisteredMutation<
			"public",
			FormArgs<TSchema>,
			Promise<FormResult<Awaited<TReturns>>>
		>;
}

/** Like `createValibotMutation`, for forms that submit to an action */
export function createValibotAction<Ctx>(builder: (definition: any) => unknown) {
	return <TSchema extends AnySchema, TReturns>(definition: FormHandlerDefinition<Ctx, TSchema, TReturns>) =>
		builder(formDefinition(definition)) as RegisteredAction<
			"public",
			FormArgs<TSchema>,
			Promise<FormResult<Awaited<TReturns>>>
		>;
}
