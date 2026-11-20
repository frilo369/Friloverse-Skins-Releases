# Scripts

Shared helpers live in `scripts/lib/runtime.mjs`:
- `ensureZstdRuntime(import.meta.url)` — automatically re-runs scripts that read League WADs or `.modpkg` archives under Electron's bundled Node 24 when the host Node lacks `zlib.zstdDecompressSync`.
- `assertMachineIdle()` — refuses real-machine LTK/League scripts while a draft, match, or LTK Manager is active.

## App, Checks & Tests
- `start.mjs` — launches Friloverse (`npm start`, `npm run preview`).
- `check.mjs` — syntax-checks every `.mjs`, `.cjs`, and `.js` file in `src/`, `scripts/`, `tests/`, and `logs-worker/src/`.
- `test.mjs` — runs the full `tests/*.test.mjs` suite (auto-using bundled Node 24 so zstd tests are not skipped).

## Build & Release
- `bump-version.mjs` — increments `package.json` and `package-lock.json` (`x.0`..`x.9`, then `(x+1).0`).
- `build.mjs` — packages the Windows app, Squirrel installer, delta `.nupkg`, `RELEASES`, and Complete Setup (`npm run build`).
- `build-complete.mjs` — compiles `complete-setup.nsi` with NSIS (`npm run build:complete`).
- `build-ltf.mjs` — compiles `native/ltf` into `src/native/ltf/{ltk_launcher.exe,LeagueToolFlop.dll}` with MSVC.
- `sign.mjs` — Authenticode signing for `build.mjs` and `build-complete.mjs`; off until a certificate is set in the environment (header of the file lists the variables).
- `release-feed.mjs` — shared `RELEASES` and delta-feed helpers used by `build.mjs`, `publish-release.mjs`, and `verify-update.mjs`.
- `publish-release.mjs` — validates and publishes a release to `frilo369/Friloverse-Skins-Releases`.
- `release-riot-database.mjs` — validates form packages and publishes a release on `frilo369/Friloverse_Skins_Database`.
- `create-install-gif.mjs` — generates `scripts/installing.gif` for the Squirrel splash screen.

## Data, Catalogues & Art Sync
- `convert-phantom-export.mjs` — runs FrYiLo Phantom and/or converts a Phantom snapshot into the Riot skin database.
- `convert-riot-database.mjs` — converts local FrYiLoCo Riot archives into the Friloverse Riot database.
- `sync-riot-catalog.mjs` — refreshes `src/fryilo-catalog/` and form art from the sibling FrYiLoCo checkout.
- `sync-party-icons.mjs` — refreshes `src/ui/party-icons.{js,json}` and bundled Arena item icons from FrYiLoCo.
- `sync-guide-assets.mjs` — refreshes `src/ui/guide/` from FrYiLoCo (requires `--force`).
- `lobby-art/` — Python scripts (`build-brand-art.py`, `build-home-art.py`, `build-logo.py`) that generate lobby artwork.

## Party Mode Verification
- `verify-party-relay.mjs` — tests create, join, version refusal, selection sync, reconnect, Stealth, and host kick on the deployed relay.
- `verify-party-sync.mjs` — tests two `PartyCoordinator` instances exchanging skin hashes, preparation reports, version notices, and leave cleanup on the deployed relay.
- `verify-party-handover.mjs` — tests host hand-over (including Stealth preservation) across three temporary clients on the deployed relay.

## Skins, Audio & LTK Verification
- `node scripts/verify-divine.cjs` — clicks Import on a catalogue card and verifies the saved Local skin. Add `--live` to test the official Iron Darius download in a disposable library.
- `verify-collection.mjs` — read-only check of the local Custom Skins database and artwork coverage.
- `verify-riot-database.mjs` — read-only check of the Riot skin manifest, cards, chromas, and names.
- `verify-league-icons.mjs` — read-only check reading summoner icons from the installed League WADs.
- `verify-skin-audio.mjs` — checks `moveAudioToBase` against all installed League skins (`--all`) or reference packages.
- `compare-skin-packages.mjs` — compares two `.fantome` archives (metadata, WAD members, and `skin0.bin` objects).
- `verify-ltf-health.mjs` — read-only check of the reviewed LTF DLL health shim.
- `verify-ltf.mjs` — tests the bundled LTF bridge against a `.fantome` package outside a match.
- `verify-ltk.mjs` — read-only check of the installed LTK Manager and its settings.
- `verify-skinhack-setting.mjs` — checks whether the installed LTK Manager honours `enforceSkinhackScan: false`.
- `verify-riot-build.mjs` — builds Riot skins from installed League and checks them with real LTK Manager.
- `verify-custom.mjs` — checks every custom and local skin through real LTK Manager preflight/Repair.
- `verify-slots.mjs` — builds and verifies selected-slot (`skinN.bin`) mods across custom, local, and Riot skins.
- `verify-skin-name.mjs` — verifies loading-screen `StringOverrides` in LTK's built overlay.
- `verify-prepared-skins.mjs` — verifies staging a cached prepared skin and slot copy with real LTK Manager.
- `verify-prepare-on-pick.mjs` — verifies preparing, caching, and re-checking custom skins on pick with real LTK Manager.
- `verify-engine.mjs` — end-to-end `SkinEngine` staging and library restore check with real LTK Manager.
- `verify-arm.mjs` — verifies draft pre-arming, re-arming on changes, and late frozen-game patching with real LTK Manager.
- `verify-speed.mjs` — benchmarks skin staging latency against real LTK Manager.

## Guide, Guard, Setup & Update Verification
- `verify-guide.mjs` / `verify-guide.cjs` — renders all guide modes in isolated Electron from captured fixtures.
- `verify-guide-client.mjs` — read-only League client detection check.
- `verify-guide-live.mjs` — read-only live check of public ARAM: Mayhem data sources.
- `verify-focus.mjs` / `verify-focus.cjs` / `verify-focus-peer.cjs` — tests F1 hotkey, Alt+Tab, and focus handover against an isolated fullscreen stand-in.
- `verify-firewall.mjs` / `verify-firewall.cjs` — checks that loading MetaSRC causes no Windows Firewall prompt.
- `verify-hold.mjs` — tests `game-guard.cjs` and `GameHold` against an isolated stand-in process.
- `verify-complete-setup.mjs` — compiles and exercises `complete-setup.nsi` scenarios with disposable fixtures.
- `verify-update.mjs` — runs real Squirrel delta/full updates on an isolated throwaway install.
- `verify-rename.mjs` — tests the Divinity → Friloverse rename migration on isolated throwaway installs.

## Diagnostics
- `read-logs.mjs` — lists and unpacks player log reports from the `friloverse-logs` R2 bucket.
- `read-divine-downloads.mjs` — lists the Divine skins players saved to Local Skins (bucket `friloverse-downloads`), most downloaded first; `--added <link>` hides one once it is in the collection.
- `watch-launch.mjs` — records League client phases, windows, mouse clicks, and Friloverse/LTK logs outside Friloverse.
