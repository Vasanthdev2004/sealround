# Sealround launch video

The 1:28 launch video, built with [Remotion](https://www.remotion.dev/) (React rendered to MP4). Not part of the pnpm workspace.

| File | What |
| --- | --- |
| `src/timeline.json` | 120 BPM, 44 bars (2 s each), one scene per row. The music and the picture both read it, so cuts land on the beat. |
| `src/scenes/*.tsx` | Problem, product, proof and close scenes. |
| `src/verify-swarm.ts` | The real output of `verify-sale` on `swarm-11141341`, shown in the terminal scene. |
| `scripts/score.mjs` | The score: synthesized from scratch in Node (pads, bass, drums, plucks, bells, risers, impacts). No samples, so no licence questions. |
| `scripts/shots.mjs` | Screenshots of the app in testnet mode (read-only). |

## Build it

```sh
cd video
npm install
node scripts/score.mjs            # public/audio/score.wav
# Screens: run the web app in testnet mode on :3007 (apps/web/.env.example, contract
# sealround.itzbeast.testnet), then:
node scripts/shots.mjs            # public/shots/*.png
npx remotion render Launch out/sealround-launch.mp4
npx remotion studio               # to preview and scrub
```

Every number on screen comes from the testnet sales (`swarm-11141341`, `ember-11141303`) or the Bot Arena simulation (labelled as such).
