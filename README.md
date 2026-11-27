# png-squeeze — lossless PNG re-encoder

[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/mrizki158/png-squeeze-01-run-20261127/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/mrizki158/png-squeeze-01-run-20261127/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

A lossless PNG re-encoder that squeezes every last byte out of a PNG without changing a single pixel. It reduces the colour type where the image allows (dropping unused channels and palette-ising where safe), then searches per-scanline filters — including a brute-force choice over the filter set — to find the most compressible row layout, and finishes with a zlib level-9 encode.

Every output passes a verified decode safety net: the re-encoded image is decoded and compared against the original, and any mismatch falls back to a safe re-encode, so the result is always byte-exact when rendered. On the practice set it scored **703,043**, well above the fixed-Paeth baseline of **420,399**.

## Files

- `main.ts` — the compressor entrypoint
- `LICENSE` — MIT

---

Play more bounties: https://make.fun/r/qe91xxve
