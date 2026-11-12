export {
	configureForms,
	createConvexForm,
	createForm,
	Form,
	hasTaintedForm,
	SilentError,
	trackPendingUpload,
	valibotUndefinedDefaults,
	type ConvexForm,
	type FormDataGeneric,
	type FormOptions,
	type FormParameters,
	type GenericForm,
	type OnSubmitReturnOptions,
	type Path,
	type SubmissionState,
	type ValibotObjectSchema,
} from "./form.svelte.js";
export { valueByPath, updateByPath } from "./paths.js";
export { errorMessage, prettyErrorMessage, type FormResult } from "./shared.js";
export type { DeepKeys, DeepPartial, MaybePromise, PathValue, Prettify } from "../types.js";
