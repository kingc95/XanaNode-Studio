# XanaNode Studio Substrate

This folder is the explicit substrate source generated from the XanaNode Studio repository.

It exists so higher layers can federate with Studio as a normal substrate instead of inferring Studio facts ad hoc.

Regenerate it from the repository root with:

```powershell
node tools/build-substrate-source.mjs
```

Or from `XanaNode-Master`:

```powershell
npm run studio:build-substrate-source
```
