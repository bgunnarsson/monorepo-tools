# monorepo-tools

A set of monorepo tools to make working with pnpm workspaces easier.

### `Monorepo Structure`

Until the bgunnarsson.config.mjs will be implemented the structure needs to be:

* src/pacakges (required)
* src/plugins (optional)


### `Avaiable Commands`

Release

<small>Bumps package.json version, builds all packages and optionally plugins, run pnpm publish.</small>

```
bgunnarsson-monorepo release --bump patch
```
```
bgunnarsson-monorepo release --bump minor
```
```
bgunnarsson-monorepo release --bump major
```

Housekeeping

<small>Removes ann node_modules and dist folders</small>

```
bgunnarsson-monorepo housekeeping
```

Builds all packages and optionally plugins.
```
bgunnarsson-monorepo build
```
