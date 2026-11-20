# Code signing policy

Free code signing provided by [SignPath.io](https://signpath.io), certificate by [SignPath Foundation](https://signpath.org).

Friloverse's Windows programs (the setup, `Friloverse-Skins.exe`, the updater and the bundled
`ltk_launcher.exe` and `LeagueToolFlop.dll`) are signed only when they were built from the source in
this repository by the project's build workflow. Nothing is signed from a developer's own PC.

## Roles

| Role | Who |
| --- | --- |
| Committers and reviewers | Project maintainer [frilo369](https://github.com/frilo369), and contributors whose changes the maintainer reviews |
| Approvers (release signing) | [frilo369](https://github.com/frilo369) |

Every account with access to this repository or to the signing service uses multi-factor authentication.
Each release is approved by hand before it is signed.

## Privacy: what the program sends over the network

Friloverse does not collect accounts, names or addresses. It connects to these places, and only these:

- **GitHub** (releases, the skin databases `frilo369/Friloverse_Skins_Database` and
  `frilo369/FrYiLoCo-Custom-Skins`, and public file lists) to check for app updates and download skin
  databases and skins.
- **League's own client** on this PC (`127.0.0.1`), to read the champion select. Nothing from it is sent anywhere
  except as described next.
- **The party relay** (`fryilo-party-relay.ogfryilo.workers.dev`), only while the player is in a party:
  party code, chosen display name, champion, and the hash of each chosen skin.
- **Send logs**, only when the player presses the button: a zip of recent Friloverse and LTK Manager logs
  (Windows account names are replaced) with the player's optional note, sent to `friloverse-logs`
  (Cloudflare), kept 90 days.
- **Divine Skins** (`divineskins.gg`), only when the player uses the in-app browser to download a skin. After a
  skin is saved, the program tells `friloverse-logs.ogfryilo.workers.dev` which skin it was (its
  Divine address, champion, file name, size and hash). Nothing about the player is stored. The complete setup
  shows this on its privacy page, where it can be declined, and Settings → "Tell the developer which Divine skins
  I download" turns it off at any time. With it off nothing is sent.
- **CommunityDragon, Tencent and MetaSRC**, for picture and guide data.

## Reporting a problem

Open an issue in this repository. Security problems can be reported privately to the maintainer through
GitHub's "Report a vulnerability" feature.
