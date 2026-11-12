import { useConvexClient } from "convex-svelte";
import type { FunctionReference } from "convex/server";
import type { ConvexError } from "convex/values";
import { extract, watch, type Getter } from "runed";
import { tick } from "svelte";
import type { SvelteHTMLElements } from "svelte/elements";
import { SvelteSet } from "svelte/reactivity";
import * as v from "valibot";
import type { ObjectSchema, UnionSchema } from "valibot";
import type { DeepKeys, DeepPartial, MaybePromise, PathValue, Prettify } from "../types.js";
import { updateByPath, valueByPath } from "./paths.js";
import { errorMessage, issuePath, prettyErrorMessage, type FormResult } from "./shared.js";

/** Throw from `onSubmit` to stop a submit without showing an error */
export class SilentError extends Error {}

export type Path<TFormData extends FormDataGeneric> = DeepKeys<TFormData>;

export type FormDataGeneric = Record<string, any>;

export type ValibotObjectSchema<TFormData extends FormDataGeneric> = v.GenericSchema<TFormData>;

export type OnSubmitReturnOptions = {
	resetForm?: boolean;
};

export type FormParameters<
	TFormData extends FormDataGeneric,
	TState extends Record<string, unknown>,
	TStateOutput extends Record<string, unknown> = TState,
> = {
	schema: ValibotObjectSchema<TFormData>;
	initialData?: Getter<MaybePromise<DeepPartial<Prettify<TFormData>>>>;
	onSubmit: (props: {
		data: TFormData;
		form: Form<TFormData, TStateOutput>;
	}) => MaybePromise<void | OnSubmitReturnOptions>;
	state?: TState;
	leaveConfirmationMessage?: string;
	shouldSubmit?: (props: { data: TFormData; form: Form<TFormData, TStateOutput> }) => MaybePromise<boolean>;
	preValidate?: (props: { data: DeepPartial<TFormData>; form: Form<TFormData, TStateOutput> }) => MaybePromise<void>;
	onReset?: (props: { data: DeepPartial<TFormData>; form: Form<TFormData, TStateOutput> }) => void;
};

export type SubmissionState = "idle" | "submitting" | "submitted";

export type FormOptions = {
	/**
	 * Shows the error of a submit started from code while no submit button is registered to show
	 * it, like with a toast. Without it the error is only logged.
	 */
	showError?: (message: string) => void;
	/** Asks before leaving a form with unsaved input. Defaults to the browser's confirm dialog. */
	confirmLeave?: (message: string) => MaybePromise<boolean>;
};

const formOptions: FormOptions = {};

/** Sets app-wide form behavior. Call once, like in the root layout. */
export function configureForms(options: FormOptions) {
	Object.assign(formOptions, options);
}

type AnyObjectSchema =
	| v.ObjectSchema<v.ObjectEntries, any>
	| v.LooseObjectSchema<v.ObjectEntries, any>
	| v.StrictObjectSchema<v.ObjectEntries, any>;

type AnySchema = v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>;

/** The schema of the field at a dotted path, as written in its object schema (pipes still attached) */
function fieldSchema(schema: AnySchema, path: string): AnySchema | undefined {
	let current: AnySchema | undefined = schema;

	for (const key of path.split(".")) {
		if (current && "pipe" in current && Array.isArray(current.pipe)) {
			current = current.pipe[0];
		}

		// An index like [0] steps into an array's item schema
		if (/^\[\d+\]$/.test(key)) {
			current = current && "item" in current ? (current.item as AnySchema) : undefined;
			continue;
		}

		if (!current || !("entries" in current)) return undefined;

		current = (current as AnyObjectSchema).entries[key];
	}

	return current;
}

function isFieldOptional(schema: AnySchema, path: string): boolean {
	let current = fieldSchema(schema, path);
	if (!current) return false;

	if ("pipe" in current && Array.isArray(current.pipe)) {
		current = current.pipe[0] as AnySchema;
	}

	return ["optional", "nullish", "exactOptional"].includes(current.type);
}

/** The field's v.maxLength requirement, looking through nested pipes and optional wrappers */
function fieldMaxLength(schema: AnySchema, path: string): number | undefined {
	function find(item: unknown): number | undefined {
		if (!item || typeof item !== "object") return undefined;
		if ("type" in item && item.type === "max_length" && "requirement" in item) return item.requirement as number;
		if ("pipe" in item && Array.isArray(item.pipe)) {
			for (const pipeItem of item.pipe) {
				const found = find(pipeItem);
				if (found !== undefined) return found;
			}
		}
		if ("wrapped" in item) return find(item.wrapped);
		return undefined;
	}
	return find(fieldSchema(schema, path));
}

type SchemaFormData<TSchema extends ValibotObjectSchema<Record<string, any>>> =
	TSchema extends ValibotObjectSchema<infer TFormData> ? TFormData : never;
type UndefinedObject<TObject extends Record<string, any>> = Prettify<{
	[K in keyof TObject]: TObject[K] extends Record<string, any> ? Prettify<UndefinedObject<TObject[K]>> : undefined;
}>;
type ObjectSchemaGeneric = ObjectSchema<Record<string, any>, any>;

/** Every field of the schema set to undefined, recursing into nested objects */
export function valibotUndefinedDefaults<T extends ObjectSchemaGeneric | UnionSchema<ObjectSchemaGeneric[], any>>(
	schema: T,
): UndefinedObject<SchemaFormData<T>> {
	if (schema.type === "union") {
		const object: any = {};
		for (const unionSchema of schema.options) {
			Object.assign(object, valibotUndefinedDefaults(unionSchema));
		}
		return object;
	}

	if (schema?.entries === undefined) return {} as any;
	return Object.fromEntries(
		Object.entries(schema.entries).map(([key, value]: [string, any]) => [
			key,
			value.type === "object" ? valibotUndefinedDefaults(value) : undefined,
		]),
	) as any;
}

const mountedForms = new SvelteSet<Form<any, any>>();
let pendingUploads = $state(0);

/** Counts an upload toward hasTaintedForm until it settles, for uploads that start outside a submit */
export async function trackPendingUpload<T>(upload: Promise<T>) {
	pendingUploads++;
	try {
		return await upload;
	} finally {
		// Once the code awaiting the upload has run, so what it uploaded reaches a form before a reload can
		setTimeout(() => pendingUploads--);
	}
}

/** Whether a mounted form holds input, a submission, or an upload that reloading the page would lose */
export function hasTaintedForm() {
	return (
		pendingUploads > 0 ||
		[...mountedForms].some((form) => form.isTainted || form.submissionState === "submitting" || form.hasPendingSubmit)
	);
}

/**
 * A form validated by a valibot schema. Fields show their errors once blurred, and every field
 * once the form is submitted.
 */
export class Form<TFormData extends FormDataGeneric, TState extends Record<string, unknown>> {
	schema: ValibotObjectSchema<TFormData>;
	state: TState;
	#shouldSubmit: FormParameters<TFormData, TState>["shouldSubmit"];
	#onSubmit: FormParameters<TFormData, TState>["onSubmit"];
	#preValidate: FormParameters<TFormData, TState>["preValidate"];
	#initialData: Getter<DeepPartial<TFormData>> = $state.raw(() => ({}) as DeepPartial<TFormData>);
	#onReset: FormParameters<TFormData, TState>["onReset"];
	#issues: v.BaseIssue<unknown>[] = $state([]);
	#submittedButtonId = $state<string>();

	#submissionError: Error | ConvexError<any> | undefined = $state(undefined);
	clearSubmissionError = () => {
		this.#submissionError = undefined;
	};
	/* Mounted submit buttons that show a submission error themselves */
	#errorPopovers = 0;
	/* Data of the latest submit until it finishes or the form resets, so a double tap can't send it twice */
	#submittingData: string | undefined;

	#customErrors = $state({} as Record<Path<TFormData>, string[]>);
	errors = $derived.by(() => {
		const formCustomErrors = this.#customErrors;
		const formIssues = this.#issues;
		const submissionState = this.#submissionState;
		const blurredFields = this.#blurredFields;

		const schemaErrors = {} as Record<Path<TFormData>, string[]>;

		function populateSchemaErrors(issues: readonly v.BaseIssue<unknown>[]): void {
			issues.forEach((issue) => {
				if ("issues" in issue && Array.isArray(issue.issues)) {
					populateSchemaErrors(issue.issues as v.BaseIssue<unknown>[]);
				}
				const errorPath = issuePath(issue) as Path<TFormData>;

				// A field's errors show once it's blurred or the form is submitted
				if (!blurredFields.includes(errorPath) && submissionState !== "submitted") return;

				(schemaErrors[errorPath] ??= []).push(issue.message);
			});
		}

		populateSchemaErrors(formIssues);

		Object.entries(formCustomErrors).forEach(([path, errors]) => {
			if (errors === undefined) return;
			(schemaErrors[path as Path<TFormData>] ??= []).push(...(errors as string[]));
		});

		return schemaErrors;
	});

	#blurredFields: Path<TFormData>[] = $state([]);

	#submissionState: SubmissionState = $state("idle");
	/* Submits still running, which a reset doesn't clear, like an upload after its form resets for more files */
	#pendingSubmits = $state(0);

	leaveConfirmationMessage: string = $state("");

	#pristineData: DeepPartial<TFormData> = $derived(extract(this.#initialData));

	data: DeepPartial<TFormData> = $state(this.#pristineData);

	isTainted: boolean = $derived(JSON.stringify(this.data) !== JSON.stringify(this.#pristineData));

	constructor({
		schema,
		initialData,
		onSubmit,
		state,
		leaveConfirmationMessage,
		shouldSubmit,
		preValidate,
		onReset,
	}: FormParameters<TFormData, TState>) {
		this.schema = schema;

		this.#onSubmit = onSubmit;
		this.state = $state(state ?? ({} as TState));
		this.leaveConfirmationMessage =
			leaveConfirmationMessage ?? "Are you sure you want to leave this form? You'll lose what you entered.";

		this.#shouldSubmit = shouldSubmit;
		this.#preValidate = preValidate;
		this.#onReset = onReset;

		$effect(() => {
			mountedForms.add(this);
			return () => mountedForms.delete(this);
		});

		// New initial data replaces the form's data, unless someone is editing or submitting it
		watch(
			() => this.#pristineData,
			(_value, oldValue) => {
				if (
					oldValue !== undefined &&
					JSON.stringify(this.data) !== JSON.stringify(oldValue) &&
					(this.isTainted || this.submissionState === "submitting")
				) {
					return;
				}

				this.data = this.#pristineData;
			},
		);

		this.#initialData = () => {
			const value = (extract(initialData) ?? {}) as DeepPartial<TFormData>;
			if ("then" in value && typeof value.then === "function") {
				return {} as DeepPartial<TFormData>;
			}
			return value;
		};

		watch(
			() => (extract(initialData) ?? {}) as DeepPartial<TFormData>,
			(value) => {
				if ("then" in value && typeof value.then === "function") {
					tick().then(async () => {
						const awaitedValue = await value;
						this.#initialData = () => (awaitedValue ?? {}) as DeepPartial<TFormData>;
					});
				}
			},
		);
	}

	async validate() {
		this.#customErrors = {} as Record<Path<TFormData>, string[]>;
		const dataWithDefaults = {
			...(await v.getDefaultsAsync(this.schema as any)),
			...(this.data as any),
		};
		const result = await v.safeParseAsync(this.schema, dataWithDefaults);
		if (result.success) {
			if (this.#issues.length !== 0) this.#issues = [];
			return { success: true as const, data: result.output as TFormData };
		}
		this.#issues = result.issues;
		return { success: false as const, issues: result.issues };
	}

	get getFieldErrorsByPath() {
		const errors = this.errors;
		return (path: Path<TFormData>) => errors[path];
	}

	setFieldErrorMessages(path: Path<TFormData>, errors: string[] | string) {
		this.#customErrors[path] = Array.isArray(errors) ? errors : [errors];
	}

	reset(newData?: DeepPartial<TFormData>) {
		/* A reset hands the form back for new input, like a form picking more files mid-upload */
		this.#submittingData = undefined;
		this.#resetForm(newData);
	}

	/* Leaves the double-submit guard alone, so a finished submit can't clear one still running */
	#resetForm(newData?: DeepPartial<TFormData>) {
		const entireNewData = {
			...(extract(this.#initialData) as any),
			...(newData as any),
		};

		this.#issues = [];
		this.#customErrors = {} as any;
		this.#submissionError = undefined;
		this.#blurredFields = [];
		this.#submissionState = "idle";
		this.#pristineData = entireNewData;
		this.data = entireNewData;
		this.#onReset?.({ data: this.data, form: this });
	}

	onFieldBlur = async (path: Path<TFormData>) => {
		this.#blurredFields.push(path);
		await this.validate();
	};

	/** Whether it's fine to leave the form, asking first when it holds unsaved input */
	shouldLeaveConfirmation = async () => {
		if (!this.isTainted) return true;
		const confirmLeave = formOptions.confirmLeave ?? ((message: string) => window.confirm(message));
		return await confirmLeave(this.leaveConfirmationMessage);
	};

	onfocusout: NonNullable<SvelteHTMLElements["form"]["onfocusout"]> = (event) => {
		const path = (event.target as HTMLElement)?.getAttribute("name") as Path<TFormData> | undefined;
		if (path) this.onFieldBlur(path);
	};

	oninput: NonNullable<SvelteHTMLElements["form"]["oninput"]> = () => {
		this.validate();
	};

	onsubmit = async (e?: SubmitEvent) => {
		e?.preventDefault();

		const submittingData = JSON.stringify(this.data);
		if (this.#submittingData === submittingData) return;
		this.#submittingData = submittingData;

		this.#submittedButtonId = e?.submitter?.id;
		this.#submissionError = undefined;
		this.#submissionState = "submitting";
		this.#pendingSubmits++;

		try {
			await tick();

			await this.#preValidate?.({ data: this.data, form: this });

			const { success, data: validatedData } = await this.validate();
			if (success === false) {
				this.#submissionState = "submitted";
				return;
			}

			if (this.#shouldSubmit && !(await this.#shouldSubmit({ data: validatedData, form: this }))) {
				this.#submissionState = "submitted";
				return;
			}

			const onSubmitReturn = await this.#onSubmit({ data: validatedData, form: this });
			this.#submissionState = "submitted";
			// Resetting to the validated data clears the errors and makes it the new pristine data
			if (typeof onSubmitReturn !== "object" || onSubmitReturn.resetForm !== false) {
				this.#resetForm(validatedData as any);
			}
			this.#submittedButtonId = undefined;
		} catch (error: any) {
			this.#submissionState = "submitted";
			if (!(error instanceof SilentError)) {
				this.#submissionError = error;
				console.error("The form's submit failed", error);
				// A submit started from code has no submit button to show its error unless one is registered
				if (!e && this.#errorPopovers === 0) {
					formOptions.showError?.(prettyErrorMessage(errorMessage(error)));
				}
			}
		} finally {
			this.#pendingSubmits--;
			if (this.#submittingData === submittingData) {
				this.#submittingData = undefined;
			}
		}
	};

	/**
	 * A submit button that shows `submissionError` itself calls this while mounted, so errors of
	 * submits started from code are left to it instead of `showError`. Returns the unregister function.
	 */
	registerErrorPopover() {
		this.#errorPopovers++;
		return () => {
			this.#errorPopovers--;
		};
	}

	async submit(data?: DeepPartial<TFormData>) {
		if (data) this.data = data;
		return await this.onsubmit();
	}

	isFieldOptional(path: Path<TFormData>) {
		return isFieldOptional(this.schema, path);
	}

	fieldMaxLength(path: Path<TFormData>) {
		return fieldMaxLength(this.schema, path);
	}

	/** A `current` getter and setter for the field at a path, for binding inputs to nested fields */
	get valueProxy() {
		const data = () => this.data;
		return <TPath extends Path<TFormData>, TCurrent = DeepPartial<PathValue<TFormData, TPath>>>(path: TPath) => ({
			get current(): TCurrent | undefined {
				return valueByPath(data(), path as any);
			},
			set current(value: any) {
				updateByPath(data(), path as any, value);
			},
		});
	}

	get method() {
		return "post" as const;
	}

	get initialData() {
		return extract(this.#initialData);
	}

	get pristineData() {
		return this.#pristineData;
	}

	get issues() {
		return this.#issues;
	}

	get blurredFields() {
		return this.#blurredFields;
	}

	get submissionState() {
		return $state.eager(this.#submissionState);
	}

	set submissionState(state: SubmissionState) {
		this.#submissionState = state;
	}

	get hasPendingSubmit() {
		return this.#pendingSubmits > 0;
	}

	get submittedButtonId() {
		return this.#submittedButtonId;
	}

	get submissionError() {
		return this.#submissionError;
	}
}

export function createForm<TFormData extends FormDataGeneric, TState extends Record<string, unknown>>(
	params: FormParameters<TFormData, TState>,
) {
	return new Form(params);
}

const convexFormDefaultState = {
	open: false,
};
type ConvexFormState<TState extends Record<string, unknown>> = TState & typeof convexFormDefaultState;
type ConvexFormArgs<TFormData extends FormDataGeneric> = { formData: TFormData; timezone: string };
type ConvexFormFunction<TFormData extends FormDataGeneric> = FunctionReference<
	"mutation" | "action",
	"public",
	ConvexFormArgs<TFormData>,
	FormResult<any>
>;

/**
 * A form that submits to a mutation or action made with `createValibotMutation` or
 * `createValibotAction`, showing the server's field errors on the form's fields. A successful
 * submit closes it through `state.open`.
 */
export function createConvexForm<
	TFunction extends ConvexFormFunction<TFormData>,
	TFormData extends FormDataGeneric,
	TState extends Record<string, any>,
>(
	params: Omit<FormParameters<TFormData, TState, ConvexFormState<TState>>, "onSubmit"> & {
		mutation?: TFunction;
		action?: TFunction;
		afterSuccessfulSubmit?: (props: {
			data: TFormData;
			form: ConvexForm<TFunction, TFormData, TState>;
			response: Prettify<Omit<Extract<TFunction["_returnType"], { success: true }>, "errors">>;
		}) => MaybePromise<void | OnSubmitReturnOptions>;
	},
): ConvexForm<TFunction, TFormData, TState> {
	const convexClient = useConvexClient();

	const form = new Form<TFormData, ConvexFormState<TState>>({
		...params,
		onSubmit: async ({ data, form }) => {
			const args = {
				formData: data,
				timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
			};
			const response: FormResult<unknown> = params.action
				? await convexClient.action(params.action as FunctionReference<"action", "public">, args)
				: params.mutation
					? await convexClient.mutation(params.mutation as FunctionReference<"mutation", "public">, args)
					: (() => {
							throw new Error("A Convex form needs a mutation or an action to submit to");
						})();
			if (response.success === false) {
				response.errors.forEach((error) => {
					form.setFieldErrorMessages(error.key as Path<TFormData>, error.message);
				});
				// Resetting would clear the errors the server just set
				return { resetForm: false };
			}

			form.state.open = false;

			return await params.afterSuccessfulSubmit?.({ data, form: form as any, response: response as any });
		},
		state: {
			...convexFormDefaultState,
			...params.state,
		} as any,
	});

	return Object.assign(form, {
		resetOpen: (values?: DeepPartial<TFormData>) => {
			form.reset(values);
			form.state.open = true;
		},
	});
}

export type ConvexForm<
	_TFunction extends ConvexFormFunction<TFormData>,
	TFormData extends FormDataGeneric,
	TState extends Record<string, unknown>,
> = Form<TFormData, ConvexFormState<TState>> & {
	/** Resets the form and opens it */
	resetOpen: (values?: DeepPartial<TFormData>) => void;
};

export type GenericForm<TFormData extends FormDataGeneric> = Form<TFormData, any>;
