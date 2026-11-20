# Signing Friloverse with SignPath

Releases are built and signed by `.github/workflows/release.yml` (Actions tab → *Release build* →
*Run workflow*). It uses [SignPath Foundation](https://signpath.org/), which signs open source
projects for free. The files here are what SignPath needs to know about this project.

## One-time setup

1. **Two-factor authentication** on your GitHub account and on SignPath. SignPath Foundation requires it
   for everyone with access.
2. **Apply** at <https://signpath.org/apply> with this repository
   (`https://github.com/frilo369/Friloverse-Skins-Releases`). Approval is by hand and can take days. The
   application asks for the license (MIT), the project description, and that the code-signing policy page
   (`CODE_SIGNING_POLICY.md`) and the credit line in the README exist: they do.
3. In SignPath, once approved, in the project:
   - **Artifact configuration**: paste `.signpath/artifact-configuration.xml` (make it the default, or
     remember its slug).
   - **Trusted build system**: link GitHub.com and add this repository to the project.
   - **Signing policy** `release-signing`: require **approval** by you. Each release asks three times
     (programs, plain setup, complete setup).
   - Create an **API token** for a CI user that may submit to that policy.
4. In this repository (Settings → Secrets and variables → Actions):
   - Secret `SIGNPATH_API_TOKEN`: the token.
   - Variables `SIGNPATH_ORGANIZATION_ID`, `SIGNPATH_PROJECT_SLUG`, `SIGNPATH_SIGNING_POLICY_SLUG`
     (usually `release-signing`) and, if it is not the default, `SIGNPATH_ARTIFACT_CONFIGURATION_SLUG`.
5. Raise the version in `package.json` as usual (x.y.0, one step up), commit, then run the workflow.
   Leave *publish* off the first time: the run ends with the signed setups as a downloadable build and
   checks the update against the feed rules. Run it again with *publish* on to release.

## How a run works

`scripts/sign.mjs` can hand signing to another program (`FRILOVERSE_SIGN_EXTERNAL=1`). It gives every
program its signed copy from a cache keyed by the hash of the unsigned file, and copies the ones it
has no copy of into a folder. The workflow builds once to find them, has SignPath sign that folder,
builds again with the signed copies (the plain setup comes out unsigned and is signed next), then builds
the complete setup around the signed plain setup and signs that too. `scripts/signpath.mjs` puts
signed files back and refuses one without a signature. Windows' own check of every program finishes the run.

The cache also keeps the 250 MB Electron exe the same file between releases, so updates stay small.
If the cache is lost (GitHub drops caches after 7 days of no use), that release's update is larger once.

## Things that may need a decision from SignPath

- SignPath Foundation signs software it can trace to its source. The workflow signs Electron's own
  Chromium files and Friloverse's bundled `ltk_launcher.exe` and `LeagueToolFlop.dll` (built from the
  MIT sources in `native/ltf`). If the approvers want only Friloverse's own programs signed,
  narrow the `include` lines in the artifact configuration; Windows may then still treat the rest as
  unsigned.
- The 7-Zip files the complete setup carries are Igor Pavlov's and stay as he ships them.
