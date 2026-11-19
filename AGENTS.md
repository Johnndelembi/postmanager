# Project guidance

Read [README.md](README.md) for the product direction before changing the application.

For Neon work, use Neon's current agent guidance at https://neon.com/.well-known/agent-skills/neon/SKILL.md and the relevant feature skill it names. Keep database schema changes in versioned migrations. Use a Neon branch for schema changes and check the diff before applying them to the main branch. Never commit connection strings, API keys, or SMS credentials.
