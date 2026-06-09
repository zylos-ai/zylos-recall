# Decisions

## Subagent Model Inheritance

Background subagents should inherit the current runtime's supported model and
tooling configuration. Do not hardcode Claude-only model names when running
under Codex. Memory Sync must use the runtime-supported subagent mechanism.

## Component Naming

Component package names use the repository name, but installed skill directory
names omit an extra zylos prefix when the component manager already supplies the
namespace. Avoid names like zylos-zylos-example.

## WAB Onboarding

WhatsApp Business onboarding is paused until live WABA and COCO Meta
verification are ready. Resume with webhook override, live-fire end to end
testing, release tagging, and registry publication after verification clears.

