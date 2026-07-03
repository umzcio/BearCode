# BearCode

A desktop agent manager for macOS. Point an AI agent at a folder, give it a task, and watch it plan, run tools, and produce reviewable diffs. Built with Electron, React, and TypeScript; the agent runtime is named ursa.

The approved visual reference lives at `design/bearcode-prototype.html`.

## Development

```sh
npm install
npm run dev        # launch the app with HMR
npm run typecheck  # strict TS across main, preload, renderer
npm run lint
npm run build:mac  # package a dmg
```
