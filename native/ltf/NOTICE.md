# LeagueToolFlop (LTF) vendored in Friloverse

`native/ltf/LeagueToolFlop-inj.cpp` and `native/ltf/LeagueToolFlop_dll.cpp` are
LeagueToolFlop (LTF) by **lol123love**, taken from Rose's vendored copy at
<https://github.com/Alban1911/Rose/tree/main/native/ltf> (MIT License, see
`LICENSE`). Rose documents its own changes in `VENDORED.md`; Friloverse uses
that same version unmodified.

`src/native/ltf/ltk_launcher.exe` and `src/native/ltf/LeagueToolFlop.dll` are
built from those sources with `scripts/build-ltf.mjs` (MSVC x64, `/MT`,
C++20). They are shipped with Friloverse so it does not need Rose installed.

What Friloverse uses: the launcher starts LTK Manager as a child of Explorer
and injects the DLL; the DLL serves its token-protected local API for
`import`, `uninstall`, `toggle`, `list`, `check_mod_health`, `repair_mod`,
`start_patcher`, `stop_patcher` and `patcher_status`.

What Friloverse does not use: the DLL's health-verdict UI spoof is not a
verdict Friloverse trusts. Picks are judged with `check_mod_health`, and the
game's own overlay verification is untouched. The DLL's automatic background
health check is switched off, matching the owner's setting, but never replaces
the real check.

LeagueToolFlop is an independent project; Friloverse is not affiliated with it
or with Rose.
