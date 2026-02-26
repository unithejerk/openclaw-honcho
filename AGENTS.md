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
