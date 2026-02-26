# AGENTS.md

## Cursor Cloud specific instructions

This is a single-package TypeScript plugin (`@honcho-ai/openclaw-honcho`) for the OpenClaw AI assistant platform. It is not a standalone application — it runs as a plugin inside OpenClaw's gateway process.

### Key commands

- **Install deps**: `pnpm install`
- **Build**: `pnpm build` (runs `tsc`, outputs to `dist/`)
- **Test**: `pnpm test` (runs `vitest`; no test files exist yet, so it exits with code 1 — this is expected)
- **Type check / lint**: `npx tsc --noEmit` (no ESLint or Prettier configured; TypeScript type checking is the primary lint mechanism)

### Gotchas

- The `postinstall` script (`node install.js`) prints guidance about running the honcho-setup skill. It is harmless and expected.
- `pnpm install` may warn about ignored build scripts from transitive dependencies (esbuild, sharp, protobufjs, etc.). These are from the `openclaw` peer dependency and do not affect plugin development. Do **not** run `pnpm approve-builds` (interactive).
- The `openclaw` peer dependency is resolved automatically by pnpm. You do not need OpenClaw installed globally to build or type-check.
- `workspace_md/AGENTS.md` is a **template file** shipped to OpenClaw users, not instructions for developing this repo.
- The compiled output in `dist/` is what gets published to npm. Always run `pnpm build` after making changes to verify compilation.
- To verify the plugin loads correctly: `node -e "import('./dist/index.js').then(m => console.log(m.default.id, m.default.kind))"` should print `openclaw-honcho memory`.

### End-to-end testing with OpenClaw

To test the plugin inside OpenClaw (requires `HONCHO_API_KEY` env var):

1. Install OpenClaw globally: `npm install -g openclaw`
2. Initialize: `openclaw onboard --non-interactive --accept-risk --auth-choice skip --skip-channels --skip-skills --skip-daemon --skip-health --skip-ui`
3. Set up the API key: `echo "HONCHO_API_KEY=$HONCHO_API_KEY" > ~/.openclaw/.env`
4. Build the plugin: `pnpm build`
5. Install via link: `openclaw plugins install --link /workspace`
6. Enable: `openclaw plugins enable openclaw-honcho`
7. Start the gateway: `openclaw gateway --allow-unconfigured --force` (runs in foreground; background with `&`)
8. Verify: `openclaw honcho status` should show "Connected to Honcho"
9. Test queries: `openclaw honcho ask "What is the user's name?"` or `openclaw honcho search "query"`

After code changes, rebuild with `pnpm build` and restart the gateway with `openclaw gateway --allow-unconfigured --force`.
