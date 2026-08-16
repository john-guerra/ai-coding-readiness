## What changed

## Why

## How this was verified

- [ ] `npm test`
- [ ] `npm run typecheck`
- [ ] `npm run format:check`
- [ ] If a check's behavior changed: ran `node bin/audit.mjs --path .` and, if
      relevant, against another repo — pasted the before/after finding below.

## Notes for the reviewer

Anything that needs a second look: a `precondition` you're not fully sure is
safe, a regex you'd like someone to try to break, a false-positive/negative
you traded off deliberately.
