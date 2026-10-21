## Summary

<!-- What problem does this change solve? -->

## Change

<!-- What did you change, and why this approach? -->

## Verification

<!-- Commands run and manual checks. -->

- [ ] `npm run check` passes
- [ ] `npm audit --omit=dev --audit-level=high` reports no vulnerabilities
- [ ] `npm pack --dry-run` shows the expected package contents
- [ ] Tests cover the behavior change
- [ ] Live integration tests were not needed, or were run with `CHUTES_RUN_LIVE=1`

## Checklist

- [ ] Focused change, one problem per pull request
- [ ] Logic belongs in `src/core/`; the MCP and CLI frontends stay thin
- [ ] Documentation and `CHANGELOG.md` updated when behavior changed
- [ ] No API keys, secrets, or generated assets are committed
- [ ] Required CI checks pass
