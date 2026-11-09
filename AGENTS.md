# phi development

phi is an MIT-licensed fork of [Pi](https://github.com/earendil-works/pi).
The public tree has no private router, private hub content, or default company gateway.
Keep service integrations configurable and opt-in.

Node.js >=22.19 is required. Install with `npm ci --ignore-scripts`, build from
committed model data using `npm run build:offline`, and check with `npm run check`.
Run non-e2e tests through `./test.sh`, which isolates credentials and the home
directory. Avoid the unguarded full Vitest runner when local private service
tokens are present. Test the exported tree without credentials.

Use `git commit -s` for contributions. Preserve the original upstream MIT
license and copyright notices; see NOTICE. Do not add real sessions, employee
identities, private service endpoints, secrets or private hub bundles to tests.
