# FreeField: guide for Claude Code

FreeField is open-source field BIM (MIT): IFC models, calibrated PDF plans and site issues in one web app. Each company runs it on **its own** Firebase project.

Many people who open this repo are **not programmers**. They are BIM/VDC managers, field engineers or ops leads with a Claude Code licence, often working in Spanish. Answer in the user's language. Explain what you're about to do in plain words, run the commands yourself, and ask before anything that costs money, touches a production project or deploys.

## What the user usually wants, and which skill to use

| The user wants to… | Use |
|---|---|
| Try it on their computer, put it online for the team or company, set up Firebase, use a custom domain, or work out **what to ask IT for** | the `freefield-deploy` skill |
| Change how it works or add something: a field on tasks, a new task type, a report column, a connection to another system, their own branding | the `freefield-extend` skill |

If you're not sure which, ask one short question: "¿Quieres ponerlo en marcha para tu equipo, o cambiar algo de cómo funciona?" / "Do you want to get it running for your team, or change how it works?"

## Quick facts
- Requirements: Node.js 20+ and pnpm 10. Install with `pnpm install`.
- Run it locally: `pnpm --filter settings dev`. It starts in demo mode, with no backend and no sign-in.
- Deploying for real: `docs/deploy/self-hosting.md`, which the `freefield-deploy` skill walks through.
- Before any commit: `pnpm typecheck`, `pnpm lint` and `pnpm test`.
- Data is local-first. Models, PDFs and calibrations start in the browser (IndexedDB). In a signed-in project, an admin can **publish** buildings, and from then on the converted model, the PDFs and the calibrations sync to the company's own Firebase (Firestore + Storage) for the whole team. Tasks, projects and members always sync there. Demo mode keeps everything in the browser. The original IFC file isn't uploaded.

## House rules
- Never ask the user to paste passwords, API keys or service-account files into the chat.
- Keep changes small and on a branch, so the company's fork can still pull updates from upstream.
- Don't name third-party BIM or construction platforms in code, docs or commits.
