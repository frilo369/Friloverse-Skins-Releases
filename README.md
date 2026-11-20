# Friloverse

Called Divinity until 3.9.

A Windows champion-select companion for League of Legends: custom skins, Local Skins,
custom mods, and a party mode where friends' picks appear in each other's games.
Skins are patched by the real [LTK Manager](https://github.com/LeagueToolkit/ltk-manager),
which Friloverse starts and drives itself. The gold/navy overlay follows the owner's
FrYiLoCo design; FrYiLoCo's repository, patcher and relay client are reused, not changed.

## Use

Run **Friloverse Complete Setup** on 64-bit Windows, once. It installs LTK Manager
(accepting its licence, downloading the official release and verifying its SHA-256) and
Friloverse, then starts Friloverse in the system tray. There is nothing else to set up.

Friloverse runs as administrator, so Windows asks for permission when it starts; it then starts with Windows without asking again.
Keep Friloverse running. It starts with Windows by default, has no taskbar button except the in-game guide's,
and opens from its tray icon or the gold star at the League client's top left during champion select. Closing or
minimizing hides it to the tray; the tray menu quits it.

Enter champion select and the skin panel opens on your champion. One click selects a
skin, a double click enables it, and double-clicking again turns it off. Custom and local
skins sit on separate tabs; Riot skins are applied through Friloverse's bundled bridge, and the
wheel on a card opens its chromas. Every champion
select starts with skins off; choices live only in memory for that draft. When champion select ends,
Skins, Party, the gold star and the Friloverse window hide. Quitting the game during loading
or play opens the skin catalogue on League's Reconnect screen. Choose a skin, wait for
the ready banner, then press Reconnect in League. The controls hide when the game returns.
The tray can still open Friloverse manually. Custom Mods
stay as you set them, match after match.

LTK Manager only overlays a game created after its scan began, so Friloverse installs
during the draft and starts the patcher before League opens. A separate guard process
freezes the game as it is created, allowing queued picks to finish and, in a
party, receiving friends' final choices in the background. Some systems (Riot Vanguard refuses
to let another process pause the game) cannot be held; then League opens normally and a
skin picked in the last two seconds applies from the next match.

Friloverse reads the skin or chroma selected in League and places the Friloverse pick
at that slot. The League client's selection stays yours. Friloverse checks the copy
before releasing a held game and reports a pick that could not be applied.

## Riot skins

Riot skins are applied through Friloverse's bundled **LeagueToolFlop** bridge: Friloverse
starts the real LTK Manager through its own `ltk_launcher.exe` (Explorer as parent, the DLL
injected, window hidden), keeps that manager open, and imports the pick through the DLL's
token-protected local API. The patcher is started and stopped as the choice changes, so a late
pick no longer needs the game restarted for timing; the guard still holds a game that must wait.
The package is built from the installed League. Its `.skl`/`.skn` are rebuilt with one unused
null joint and one unused vertex — the same technique Rose's open-source base-skin pipeline
uses — so the model is byte-distinct from the game's while drawing and animating the same. Its
audio banks move to the base skin's paths and its events are listed under the base skin's tag,
as Rose's packages do, so LTK's in-game base-skin and audio checks accept it. No Rose
installation is needed and no Rose files are downloaded.

The Riot skin list still comes from `frilo369/Friloverse_Skins_Database` (its
`riot-skins-manifest.json`). A skin is built when it is picked (about 15 ms), kept for the
session in `%APPDATA%\friloverse-skins\built-skins`, and needs no download. Party friends
build the same skin from their own copy of the game.

LTK Manager's in-game patcher (`ltk_patcher-32`, November 2026) still enforces that check;
when it refuses a skin it turns off every mod for that game. Winterblessed Hecarim and its
chromas (`120031`–`120040`) stay hidden until that family is confirmed.

Selectable forms whose numbers are 900 or above use converted database packages for their
handcrafted data. A missing form package is downloaded once from the list's commit and
checked against its hash. Revenant Reign Viego and its six sword forms (`234043`,
`234994`–`234999`) use the rebuilt model too and are offered again. Tags and events that
name another skin are moved to the base tag, including a tag with a genre or colour suffix
and an event name at the start of a string, so multi-tag champions such as Sona pass the
audio check.

Everything the pick needs (the Riot list, the League files and the rebuilt model) is local;
the skin is built when chosen, with no package download. Every
start and every hourly check asks GitHub for the list's newest commit; an unchanged list
costs one small request and nothing else. The dashboard's transparent top-left strip shows
what is being checked or downloaded, with a count and size while custom packages arrive.

`tools/riot-skin-converter/Run-Converter.cmd` remains for maintaining that list: it
converts every archive in `%LOCALAPPDATA%\FrYiLoCo\Riot Skins` into the database folder
and writes the manifest that is uploaded to the repository. A local list newer than the
repository's is kept. For new League skins, `tools/riot-skin-converter/Build-New-Skins.cmd`
runs the installed FrYiLo Phantom against the current patch and converts its newest export
(`Convert-Phantom-Export.cmd` converts an export you already have); see that folder's
README for options.

Skins newer than the copied FrYiLoCo catalogue are named from Riot's own game data
(CommunityDragon) and cached beside the list.

## Custom skins and mods

Open **Custom Mods → Browse Divine Skins** and filter by champion. Click **Import** on a skin
card or its detail page. Friloverse downloads Divine’s first listed file when it becomes available,
saves it in that champion’s **Local Skins** folder, and shows **Imported** on the card.

Custom skins are read from `%LOCALAPPDATA%\friloverse-skins-data\Database\Custom Skins` and Custom Mods
from `%LOCALAPPDATA%\friloverse-skins-data\Database\Custom Mods`; source archives are never modified.
Existing packages in the old `%LOCALAPPDATA%\FrYiLoCo` folders are copied into the Friloverse
database on the first start and are not read from there again. Most custom skins were made
for an older League, so Friloverse prepares a repaired copy for the current version outside a
match, then lets LTK Manager Repair it. A skin that LTK Manager still flags is taken out of
the match rather than turning the overlay off for the whole game.

The database lives outside the application install folder, so uninstalling or replacing
Friloverse preserves it. An older in-folder database moves on the first start. Existing
files win a conflict; older copies remain in `Database-recovered-*` beside the database.
If migration cannot finish, startup stops and retries next time instead of opening an empty library.

## Updates

Friloverse checks `frilo369/Friloverse_Skins_Database` at start and hourly (the Riot skin
list; skipped while Riot skins are off) and the custom collections `frilo369/FrYiLoCo-Custom-Skins` and `-2`: new and reworked
custom skins and mods download into the Friloverse database, each checked by its hash. A file
you made yourself is never replaced, a skin you deleted does not come back (Check databases
restores it), and a skin taken off the collections is removed. A downloaded app update waits until Friloverse is
outside a party and a match and its window is not in use, then restarts into the tray.
The portable build cannot self-update.

### Publishing a release

With the owner's go-ahead, from a committed tree with a new version number:

1. `npm run build` (with Node 22.12+), which also makes the complete setup.
2. `node scripts/publish-release.mjs` checks the build and GitHub and changes nothing.
3. `node scripts/publish-release.mjs --publish` uploads `RELEASES`, the full `.nupkg` and its
   delta, then checks the feed. The Complete Setup stays local for sharing by hand.

Every release goes up 0.1 (2.8, 2.9, 3.0). 10.x ran on to 10.12; from 12.0 on it is always
x.0 to x.9, then the next major (12.9, 13.0). The version is `x.y.0` in `package.json`, the
tag and the `.nupkg`, as Squirrel and the feed need three parts; it is `x.y` in the UI.

## Party Mode

Choose a name and icon, then create a party or join with a four-character code. Everyone
must run the same Friloverse version. Icons come from your installed League plus bundled
Arena items; your last name and the six most recent icons stay available.

When a party member selects a skin, its archive's Git blob hash travels to everyone else
(never the file). Each PC finds that skin by its contents in its own Friloverse Custom Skins database
and then (while Riot skins are on) in its local Riot skin database, and hands it to its own LTK Manager, so every
member's game shows it. A skin someone does not have is listed as not available on that
PC. The host can remove members and turn on **Stealth**, which hides champions and picks
from the lobby while skins still sync.

## Champion build guide

During loading or a game, press **F1** (configurable in Settings) to open your champion's
build. ARAM: Mayhem uses Tencent data in English; Summoner's Rift, ARAM and Arena use
MetaSRC. The guide is raised once, does not stay on top, and lets Alt+Tab return to the
game. It stays available on League's Reconnect screen and closes when the match ends.

## Development

Use Node 22.12+ for packaging.

```text
npm install
npm start
npm run preview
npm run check
npm test
npm run build
```

`npm run build` packages `dist/<version>/Friloverse-Skins-win32-x64/Friloverse-Skins.exe` and the
Squirrel setup in `dist/<version>/setup/`. It refuses to reuse an existing folder for the
same version, so bump the version before building again. It finishes with the complete setup,
which embeds Friloverse and downloads the original LTK Manager installer: the only setup anyone gets.

### Checks that touch the real machine

These are read-only or self-contained; several refuse during a match or when LTK Manager
is open.

- `scripts/verify-ltk.mjs` reads the installed LTK Manager and its settings.
- `scripts/verify-engine.mjs` stages a converted Riot skin on real LTK Manager outside a
  match, then restores the library.
- `scripts/verify-slots.mjs` (bundled Node 24) builds `skin0`/`skinN` packages for every
  custom and local skin and a Riot sample with real LTK Manager and restores the library.
- `scripts/verify-hold.mjs [--exe=<Friloverse-Skins.exe>]` runs the real guard on a stand-in
  program: freeze, release, kill, time limit and losing Friloverse.
- `scripts/verify-party-relay.mjs` and `scripts/verify-party-sync.mjs` use two temporary
  clients on the deployed relay.
- `scripts/verify-riot-database.mjs` reads the app's Riot skin list (GitHub's manifest) with
  Riot skins on, as the bundled bridge enables them.
- `scripts/verify-riot-build.mjs [--count=N] [--skin=<id>] [--champion=<id>]` builds sample
  skins from the installed League and asks the real LTK Manager whether each loads (bundled
  Node 24, for zstd; it installs and removes temporary mods and restores the library).
- `scripts/verify-custom.mjs` runs every custom and local skin through LTK Manager's check/Repair.
- `scripts/verify-ltf.mjs --package=<file.fantome>` starts LTK Manager through the bundled
  bridge, imports a package through its DLL, starts and stops the patcher, then removes the mod
  and closes the manager. Refuses during a match.
- `scripts/verify-complete-setup.mjs` compiles the setup with mock apps and real
  registry lookups.
- `scripts/verify-update.mjs` runs real Squirrel updates on a throwaway copy.
- `scripts/verify-guide.mjs` renders all guide views from captured data;
  `verify-focus.mjs` checks F1/Alt+Tab on an isolated fullscreen stand-in.

## Limits

The app is an experimental local companion, not a Riot product. Friloverse connects only
outward (no listening port, no firewall prompt). Its party rooms live on the Friloverse
party relay (a Cloudflare Worker that began as FrYiLoCo's) and cannot carry files, only identifiers. LTK Manager 1.33.0 is the verified
version; another one is used and reported. Riot skins are applied through Friloverse's bundled
LeagueToolFlop bridge and are subject to LTK Manager's own checks. A skin that LTK Manager flags as a skin hack
cannot be made to load. Untested here: a real two-PC match end to end, and a clean-PC
install on a machine without the Riot skin database.

## License and credits

Friloverse sends nothing about the player. The one report it makes without being asked, which Divine skin was
saved from Browse Divine Skins, is described in the setup's privacy page and can be turned off in Settings; every
connection is listed in [CODE_SIGNING_POLICY.md](CODE_SIGNING_POLICY.md).

Friloverse's source code is released under the [MIT License](LICENSE). Pictures and data from League of
Legends, other artists' artwork and the Cinzel font are not covered by it; see
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Friloverse includes
[LeagueToolFlop](native/ltf/NOTICE.md) (MIT) and drives, but does not bundle, LTK Manager (GPL-3.0).
Friloverse is not endorsed by Riot Games.

Free code signing provided by [SignPath.io](https://signpath.io), certificate by
[SignPath Foundation](https://signpath.org). See [CODE_SIGNING_POLICY.md](CODE_SIGNING_POLICY.md).