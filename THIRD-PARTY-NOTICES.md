# Third-party notices

Friloverse's own code is MIT licensed (see `LICENSE`). The following is not Friloverse's
work and is not covered by that license.

## Code included in this repository

| What | Where | License |
| --- | --- | --- |
| LeagueToolFlop (LTF) by lol123love, taken from Rose's vendored copy (<https://github.com/Alban1911/Rose/tree/main/native/ltf>). The compiled launcher and DLL are shipped in `src/native/ltf`. | `native/ltf`, `src/native/ltf` | MIT, see `native/ltf/LICENSE` and `native/ltf/NOTICE.md` |
| Cinzel typeface | `src/ui/fonts` | SIL Open Font License 1.1, see `src/ui/fonts/Cinzel-LICENSE.txt` |

## Programs Friloverse uses but does not include

- **LTK Manager** (LeagueToolkit, GPL-3.0, <https://github.com/LeagueToolkit/ltk-manager>). It is not bundled:
  the complete setup downloads the official installer and checks its SHA-256 before running it.
  Friloverse is not affiliated with it.
- **npm dependencies** (Electron, koffi, ws, yauzl, electron-squirrel-startup and their own
  dependencies) are installed from npm and keep their own licenses.

## League of Legends and other artwork

Friloverse is an independent community tool. It is not endorsed by Riot Games and does not reflect the
views of Riot Games or anyone officially involved in producing or managing League of Legends. League of
Legends and Riot Games are trademarks or registered trademarks of Riot Games, Inc.

The repository contains pictures and data that belong to their owners and are included only so the app
can show them. They are **not** licensed under the MIT license:

- champion, skin, item and summoner icons and the catalogue data in `src/ui/icons`, `src/ui/arena-icons`,
  `src/ui/forms`, `src/ui/party-icons*`, `src/ui/champions.json`, `src/ui/guide` and `src/fryilo-catalog`
  (League of Legends assets and community data);
- the background pictures in `src/ui/themes` and `src/ui/artwork`, and their source files in
  `scripts/lobby-art`, which show artwork from games, series and artists other than Friloverse.

If you own something here and want it removed or credited, please open an issue.
