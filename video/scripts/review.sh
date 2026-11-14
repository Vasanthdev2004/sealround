#!/usr/bin/env bash
# Contact sheets from the rendered MP4: one tile every 2 s, and each scene cut
# at -0.3 s, 0, +0.3 s, +0.7 s. Output in out/review/.
set -e
FF="${FF:-ffmpeg}"
IN="${1:-out/sealround-launch.mp4}"
mkdir -p out/review/cuts
"$FF" -y -loglevel error -i "$IN" -vf "fps=0.5,scale=480:-1,tile=6x8" -frames:v 1 out/review/every2s.png
for t in 4 8 12 14 18 22 26 30 32 38 42 48 52 56 62 70 76 80; do
  for d in -0.3 0 0.3 0.7; do
    s=$(awk "BEGIN{print $t+$d}")
    "$FF" -y -loglevel error -ss "$s" -i "$IN" -frames:v 1 -vf scale=480:-1 "out/review/cuts/c${t}_${d}.png"
  done
done
echo done
