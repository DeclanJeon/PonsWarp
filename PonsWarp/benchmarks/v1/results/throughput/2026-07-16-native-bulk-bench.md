# Native bulk DataChannel bench (2026-07-16)

Environment: local Chromium (Playwright), same-process dual RTCPeerConnection, `pathKind=host`.

## Config sweep (16 MiB)

| chunk | highWater | lowWater | MB/s |
|------:|----------:|---------:|-----:|
| 64 KiB | 1 MiB | 256 KiB | 21.87 |
| 128 KiB | 2 MiB | 512 KiB | **26.77** |
| 240 KiB | 4 MiB | 1 MiB | 26.65 |
| 240 KiB | 8 MiB | 2 MiB | 9.02 |
| 240 KiB | 32 MiB | 8 MiB | ~6.3 (queue pressure) |

## Conclusion

- Browser raw ceiling on this host is **~25–27 MB/s** for ordered reliable bulk.
- App target ≥8 MB/s is well under raw ceiling when app path is not self-throttled.
- **Do not** set app high-water to 32 MiB on Chromium; 2–4 MiB is the sweet spot.
- Design doc initial 32 MiB host water mark is revised by measurement.
