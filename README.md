# convex-svelte-helpers

Async Svelte queries and valibot forms for [Convex](https://convex.dev) in SvelteKit.

```sh
pnpm add convex-svelte-helpers convex convex-svelte valibot
```

Turn on async Svelte in `svelte.config.js`:

```js
export default {
	compilerOptions: { experimental: { async: true } },
};
```

## Queries

Set up once in the root layout:

```svelte
<script lang="ts">
	import { setupConvex } from "convex-svelte";
	import { setupConvexQueries } from "convex-svelte-helpers/query";
	import { PUBLIC_CONVEX_URL } from "$env/static/public";

	let { children } = $props();
	setupConvex(PUBLIC_CONVEX_URL);
	setupConvexQueries();
</script>

{@render children()}
```

Then await queries in any component. They render on the server, hydrate without fetching again, and stay live. Components reading the same query share one subscription.

```svelte
<script lang="ts">
	import { convexQuery } from "convex-svelte-helpers/query";
	import { api } from "$convex/_generated/api";

	const tasks = $derived(await convexQuery(api.tasks.list, {}));
</script>

{#each tasks as task (task._id)}
	<p>{task.title}</p>
{/each}
```

Paginated queries take their pagination fields at the top level of their arguments:

```ts
// convex/tasks.ts
export const page = query({
	args: { ...paginationOptsValidator.fields },
	handler: (ctx, paginationOpts) => ctx.db.query("tasks").paginate(paginationOpts),
});
```

```svelte
<script lang="ts">
	import { paginatedConvexQuery } from "convex-svelte-helpers/query";

	const tasks = paginatedConvexQuery(api.tasks.page, {}, { initialQueryItemNumber: 20 });
	const results = $derived(await tasks);
</script>

{#each results as task (task._id)}<p>{task.title}</p>{/each}
<div {@attach tasks.intersectionObserverAttachment(20)}></div>
```

## Forms

Keep the schema where both the page and the Convex function can import it, outside files that define Convex functions:

```ts
// convex/shared/task.ts
import * as v from "valibot";

export const taskSchema = v.object({
	title: v.pipe(v.string(), v.minLength(3, "At least 3 characters")),
});
```

Make a form mutation builder from your own mutation builder, like an authenticated one. Each mutation checks the data against the schema and returns field errors the form shows:

```ts
// convex/tasks.ts
import { createValibotMutation, FormValidationError } from "convex-svelte-helpers/forms/server";
import { mutation, type MutationCtx } from "./_generated/server";
import { taskSchema } from "./shared/task";

const formMutation = createValibotMutation<MutationCtx>(mutation);

export const add = formMutation({
	schema: taskSchema,
	handler: async (ctx, data) => {
		// ctx.timezone is the browser's time zone
		if (await titleTaken(ctx, data.title)) {
			throw new FormValidationError([{ path: "title", message: "That task already exists" }]);
		}
		return await ctx.db.insert("tasks", data);
	},
});
```

```svelte
<script lang="ts">
	import { createConvexForm } from "convex-svelte-helpers/forms";
	import { api } from "$convex/_generated/api";
	import { taskSchema } from "$convex/shared/task";

	const form = createConvexForm({
		schema: taskSchema,
		mutation: api.tasks.add,
		afterSuccessfulSubmit: ({ response }) => console.log("Added", response.response),
	});
</script>

<form onsubmit={form.onsubmit} onfocusout={form.onfocusout} oninput={form.oninput}>
	<input name="title" bind:value={form.data.title} />
	{form.errors.title?.join(", ")}
	<button disabled={form.submissionState === "submitting"}>Add</button>
</form>
```

A field's errors show once it loses focus, and every field's once the form is submitted. Use `createValibotAction` and `action:` for forms that submit to an action.

Schemas can use `convexId("tasks")` for a document ID. For other custom schemas, set the Convex validator the function's arguments should use with `withConvexValidator(v.custom<Hours>(isNumber), v.number())`. Both come from `convex-svelte-helpers/forms/server`, which is also safe to import in the browser.

Optionally, set how forms show errors and confirm leaving, like with your toast and dialog components:

```ts
import { configureForms } from "convex-svelte-helpers/forms";

configureForms({
	showError: (message) => toast.error(message),
	confirmLeave: (message) => confirmDialog(message),
});
```

## License

MIT
