delete process.env.PI_TUI_MODE;
delete process.env.PI_CONTEXT_BUDGET;
// A host phi session exports this; it moves the compaction thresholds tests assert on.
delete process.env.PI_COMPACTION_SOFT_CEILING_TOKENS;
