# Brand assets

These files are the **official Lore brand assets**, published by Epic Games, Inc.
"Lore" and the Lore logo are trademarks of Epic Games, Inc. See the
[Disclaimer](../README.md#disclaimer) — this is an unofficial client and the marks
are used only to identify the software it works with.

## Files

| File | Source | Notes |
|------|--------|-------|
| `Lore_Icon_White_V1.svg` | [EpicGames/lore `docs/assets/icons`](https://github.com/EpicGames/lore/tree/main/docs/assets/icons) | Vendored verbatim (byte-for-byte identical to upstream). White icon glyph. |
| `Lore_White_V1.svg` | [EpicGames/lore `docs/assets/icons`](https://github.com/EpicGames/lore/tree/main/docs/assets/icons) | Vendored verbatim (byte-for-byte identical to upstream). White wordmark + glyph. |
| `Lore_Icon_Black_V1.svg` | [EpicGames/lore `docs/assets/icons`](https://github.com/EpicGames/lore/tree/main/docs/assets/icons) | Vendored verbatim (byte-for-byte identical to upstream). Black icon glyph, used by the light theme. |
| `Lore_Black_V1.svg` | [EpicGames/lore `docs/assets/icons`](https://github.com/EpicGames/lore/tree/main/docs/assets/icons) | Vendored verbatim (byte-for-byte identical to upstream). Black wordmark + glyph, used by the light theme. |

## App icon

`../build/icon.png` (1024×1024) is the application/installer icon consumed by
`electron-builder`. It is **derived from** the official `Lore_Icon_White_V1.svg`
glyph, composited onto a dark rounded tile so it reads on any OS background and
satisfies the square-icon requirement. The composition source is kept alongside it
as `../build/icon.svg` and can be re-rasterized with:

```bash
qlmanage -t -s 1024 -o build build/icon.svg && mv build/icon.svg.png build/icon.png
```

Assets are vendored (committed) rather than hot-linked from the upstream repo: the
build tool needs the icon as a local file at build time, and the app enforces CSP
and must work offline.
