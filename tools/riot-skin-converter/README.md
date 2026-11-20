# Riot skin converter

This folder turns Riot skin packages made for FrYiLoCo into packages Friloverse can list
and select. Source archives are never modified, and no network request is made while
converting.

## New League skins: extract, then convert

1. Finish League's update in the Riot Client.
2. Double-click **Build-New-Skins.cmd**. It runs the installed **FrYiLo Phantom**
   (`%LOCALAPPDATA%\Programs\FrYiLo Phantom\fryilo-phantom.exe`) against the installed
   League and converts its newest snapshot. Pass `--only=Ahri,Lux` to build just some
   champions, or `--cleanup` to delete the Phantom snapshot afterwards.
3. Read the report in the window. A converted skin appears in Friloverse's Riot list, with
   the snapshot's own name, the next time the panel opens.

Phantom downloads its game-path hash tables on its first connected run. If it stops with
`hashtable sync`, pass `--offline` (it then reads the installed FrYiLoCo hash support), or
run Phantom once from its own window and try again.

If you already have a Phantom export, double-click **Convert-Phantom-Export.cmd** and
drag its snapshot folder onto the window. You can also point either tool at a snapshot:

```text
Convert-Phantom-Export.cmd --export="D:\Phantom\LeagueSkins-16.22.8348910-..."
```

The converter writes:

- `%LOCALAPPDATA%\friloverse-skins-data\Database\RiotSkins` — the manifest Friloverse reads and the
  converted archives. Its layout is `champion/skin[/chroma]/<skin>.fantome`.
- `%LOCALAPPDATA%\FrYiLoCo\Riot Skins Converted\Friloverse` — the update-safe mirror, used
  when a Squirrel update replaces the app folder. It also holds the manifest.

A Phantom export is additive, so a normal run keeps entries it did not rebuild. That is
how Revenant Reign Viego's sword forms survive an export where Phantom had to skip them
(because its handcrafted reference belongs to another patch). Pass `--replace` for a
manifest built only from this snapshot.

New skins for existing champions need nothing else. A **new champion** also needs
Friloverse's bundled champion catalogue refreshed (`scripts/sync-riot-catalog.mjs`, run from
the sibling FrYiLoCo checkout) before its cards can appear.

## FrYiLoCo's installed library

Double-click **Run-Converter.cmd** to convert every `.fantome` in
`%LOCALAPPDATA%\FrYiLoCo\Riot Skins`. This is the offline fallback when Phantom is not
available, and it is what refreshes the list from FrYiLoCo's own database.

To convert just Spirit Blossom Ahri, run:

```text
Run-Converter.cmd --champion-id=103 --skin-id=103027
```

## Options

`Run-Converter.cmd` accepts `--source=<folder>`, `--output=<folder>`,
`--backup=<folder>`, `--league=<folder>`, `--champion-id=<id>`, `--skin-id=<id>`,
`--limit=<count>`, `--force` and `--replace`. By default it merges into the existing
manifest: other skins stay, and a skin whose archive fails this time keeps its previous
row instead of disappearing. `--replace` makes the manifest contain only the files
converted by this run.

`Convert-Phantom-Export.cmd` and `Build-New-Skins.cmd` accept a snapshot as the first
argument or `--export=<folder|index.json|phantom-latest.json>`, plus `--output=<folder>`,
`--backup=<folder>`, `--league=<folder>`, `--only=<champion>`, `--force`, `--replace`,
`--phantom[=<exe>]`, `--phantom-out=<folder>`, `--offline` and `--cleanup`. Their default
is to merge into the existing manifest (so entries Phantom skipped are kept);
`--replace` builds it only from that snapshot.

The latest output format is revision `r7`. It adds lenient retargeting for handcrafted
forms: a body model must still map onto League's base model, while extra particle and
sword models that the base skin does not have may stay at their own paths. Audio labels
are renamed with their authored casing (`AhriSkin27` becomes `AhriBase27`), which LTK
Manager wants for a package that calls itself the base skin.

Unsupported archive layouts are reported in the command window and omitted from the
manifest, so Friloverse never offers an incomplete conversion. A failed run still writes
the packages and manifest it did finish, and exits nonzero.

## Selectable forms

Revenant Reign Viego's six sword forms (`234994`–`234999`) are not League skin slots;
League has no `skin994.bin`. Friloverse keeps their converted package as the source of the
handcrafted data and builds the loadable package from it plus the installed League's
model, then lets LTK Manager Repair the old property types. The same path covers any
future form whose number is 900 or above.
