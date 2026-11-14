# Sealround launch video

The 1:28 launch video, built with [Remotion](https://www.remotion.dev/) (React rendered to MP4). Not part of the pnpm workspace.

| File | What |
| --- | --- |
| `src/timeline.json` | 120 BPM, 44 bars (2 s each), one scene per row. The music and the picture both read it, so cuts land on the beat. |
| `src/scenes/*.tsx` | Problem, product, proof and close scenes. |
| `src/verify-swarm.ts` | The real output of `verify-sale` on `swarm-11141341`, shown in the terminal scene. |
| `public/audio/music.wav` | Music: "Inspired" by Kevin MacLeod ([incompetech.com](https://incompetech.com)), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Credited on the end card. Not in git; the build steps below fetch it. |
| `scripts/score.mjs` | An earlier synthesized score, no longer used. |
| `scripts/shots.mjs` | Screenshots of the app in testnet mode (read-only). |
| `src/Banner.tsx` | The 1280x640 banner at the top of the repository README (also fits GitHub's social preview). |

## Build it

```sh
cd video
npm install
curl -L -o Inspired.mp3 "https://incompetech.com/music/royalty-free/mp3-royaltyfree/Inspired.mp3"
ffmpeg -i Inspired.mp3 -t 88 -af "afade=t=in:st=0:d=1.2,afade=t=out:st=83.5:d=4.5,loudnorm=I=-15:TP=-1.5:LRA=11" -ar 48000 -c:a pcm_s16le public/audio/music.wav
# Screens: run the web app in testnet mode on :3007 (apps/web/.env.example, contract
# sealround.itzbeast.testnet), then:
node scripts/shots.mjs            # public/shots/*.png
npx remotion render Launch out/sealround-launch.mp4
npx remotion still Banner ../.github/readme/banner.png --scale=1.5
npx remotion studio               # to preview and scrub
```

Every number on screen comes from the testnet sales (`swarm-11141341`, `ember-11141303`) or the Bot Arena simulation (labelled as such).
