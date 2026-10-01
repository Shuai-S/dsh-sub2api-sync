# Development Structure

This repository is a pnpm workspace. Packages live under `packages/<domain>/<package>`; the root contains workspace configuration and shared commands.

## Package boundaries

- `src/`: runtime source code.
- `src/client/`: browser/client code only; keep server-only modules out of this tree.
- `test/`: automated tests and test fixtures.
- `scripts/`: development and release helpers.
- `data/`: runtime data shipped with the package.
- `locale/`: localization resources shipped with the package.
- `lib/`: generated build output; never edit manually.
- `docs/design/`: design notes and implementation proposals.

## Required checks

Run the package checks before publishing changes:

```sh
pnpm typecheck
pnpm test
pnpm build
```

Client bundle changes must also pass `test/client-bundle.test.ts`. Client code must not import server-only configuration modules such as `config.ts`.
