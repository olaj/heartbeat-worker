# heartbeat-worker

A public, generic dead man's switch for scheduled jobs: one Cloudflare Worker, one D1 database. `README.md` is the reference for behaviour and deployment.

- **Keep it generic.** Nothing about any one deployment goes in this repo: no job names, no domains, no account or database ids, no tokens. Those live in Cloudflare secrets and on the `wrangler deploy` command line.
- **Keep it small.** No framework, no build step beyond Wrangler, no client-side JavaScript on the status page.
- **Never weaken a token check.** `PING_TOKEN` and `READ_TOKEN` are deliberately separate; neither is accepted where the other is expected.
- **Slack wording is an interface.** The first lines `*New incident for X*` and `*Automatically resolved X incident*` copy Better Stack's, and automated readers depend on them.
- **Schema changes are new files in `migrations/`,** never edits to an applied one.
- `npm run check` must pass before pushing. CI runs the same.

The owner reads pull requests as a product owner: say what changes for a user of the Worker and what could break, before how.
