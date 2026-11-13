// Run the same historical-producer suite using only the explicitly selected actual SDK.
process.env.DSS_SKILL_ACTUAL_SDK = '1'
await import('./validate-local-upgrade-skill.mjs')
