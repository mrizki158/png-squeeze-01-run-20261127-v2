# png-squeeze — lossless PNG re-encoder

[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/mrizki158/png-squeeze-01-run-20261127/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/mrizki158/png-squeeze-01-run-20261127/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

A lossless PNG re-encoder that squeezes every last byte out of a PNG without changing a single pixel. It reduces the colour type where the image allows (dropping unused channels and palette-ising where safe, with palette entries ordered by colour value), then picks the filter assignment per instance from a small candidate set (per-row entropy choice, all-None, all-Paeth, all-Up) judged by zlib level 9, and finishes with an optimal-parse DEFLATE encoder: hash-chained LZ77 matches, a dynamic-programming parse with an accurate bit-cost model, and length-limited dynamic Huffman codes (package-merge), one block at a time, fixed vs dynamic chosen by exact bit cost.

Every output passes a verified decode safety net: the re-encoded image is decoded and compared against the original, and any mismatch falls back to a safe re-encode, so the result is always byte-exact when rendered. On the practice set it scored **716,744**, above the v2 entry's 703,043 (fixed-Paeth baseline: 420,399).

## Files

- `main.ts` — the compressor entrypoint
- `LICENSE` — MIT

---

Play more bounties: https://make.fun/r/qe91xxve
