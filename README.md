# AAB (All About Badges)

An [Equicord](https://github.com/Equicord/Equicord) plugin that lets you choose how Discord badges appear on your profile, using Discord's own badge menus. Show or hide any badge, reorder them, and pick any tier.

Everything is client-side. It doesn't give you real badges or change what Discord has on record for your account. People without this plugin keep seeing your real badges.

> In Equicord's plugin list this plugin appears as **HideMyBadges**.

## What it does

- **Every badge in one place:** lists all the badges in Discord's catalog, with Discord's own icons, names and tier lists, in the native "Customize your badges" popout and "Your badges" window.
- **Show or hide anything:** toggle any badge, including Nitro, from the popout's menu or the eye icon in the badge window.
- **Reorder:** drag badges in the popout, as with native badge management. Discord Staff stays first, as it does natively.
- **Pick any tier:** every tier is clickable and lock icons are removed. Picking a tier immediately updates the icon, hover card and progress bar. Click the selected tier again to go back to your real one.
- **Native look:** hover cards and info boxes use Discord's own components and text.
- **Optional sharing:** other people with this plugin can see your choices. See [Sharing](#sharing).

It also turns on Discord's `2026-08-badge-management` experiment locally, so you don't need to enable that yourself.

## Requirements

- Discord desktop app
- [Git](https://git-scm.com/)
- [Node.js](https://nodejs.org/) 22 or newer
- pnpm (`npm i -g pnpm`)
- Access to this private repository

## Install on Windows

Run these in PowerShell. Install the tools first if you don't have them:

```powershell
winget install Git.Git
winget install OpenJS.NodeJS
npm i -g pnpm
```

Open a new PowerShell window, then build Equicord with the plugin:

```powershell
git clone https://github.com/Equicord/Equicord
cd Equicord
git clone https://github.com/xanaxfather/AAB.git src/userplugins/AAB
pnpm install --frozen-lockfile
pnpm build
```

Close Discord completely, including from the system tray, then install Equicord:

```powershell
pnpm inject
```

## Install on Mac

Run these in Terminal. Install the tools first if you don't have them. This uses [Homebrew](https://brew.sh/):

```bash
brew install git node
npm i -g pnpm
```

Then build Equicord with the plugin:

```bash
git clone https://github.com/Equicord/Equicord
cd Equicord
git clone https://github.com/xanaxfather/AAB.git src/userplugins/AAB
pnpm install --frozen-lockfile
pnpm build
```

Quit Discord completely (Cmd+Q), then install Equicord:

```bash
pnpm inject
```

If macOS blocks the installer from changing Discord, allow your terminal under **System Settings > Privacy & Security > App Management**, then run it again.

## Turn it on

1. Open Discord.
2. Go to **User Settings > Equicord > Plugins**.
3. Search for **HideMyBadges** and enable it.
4. Restart Discord when asked.

Then open your profile and click your badges, or the pencil next to them, to open **Customize your badges**. Click **View Badges** for the full window.

If you already run Equicord from source, you only need the `git clone` line for this repository, `pnpm build`, and a Discord restart.

## Sharing

Sharing is off by default. Turn on **shareSelections** in the plugin's settings to let other people with this plugin see your choices.

There's no server involved. The plugin saves an invisible code to your real Discord bio, and other plugin users read it when they view your profile. This means:

- Your visible bio text stays the same, and the code updates a few seconds after you change your badges.
- Turning sharing off removes the code.
- The code takes up bio space. If it wouldn't fit, you get an error and your bio isn't changed.
- Shared Discord Staff badges are ignored, so nobody can pose as Discord staff to other plugin users.
- To stop seeing other people's shared choices, turn off **seeShared**.

## Good to know

- **Badge text:** Discord only sends a badge's description and hover text to people who own it. The plugin includes text seen on real holders of four of those badges. HypeSquad Events, Bug Hunter, Golden Bug Hunter, Early Verified Bot Developer and Discord Staff show only their name until you open the profile of someone who holds them, which gives the plugin Discord's real text.
- **Tiers you haven't earned:** text like "20 hours streamed to others" uses Discord's format with that tier's minimum, not a real count. Unlock dates may show when you first got the badge.
- **Discord updates can break it:** the plugin patches Discord's code, so an update can stop parts of it working until the patches are fixed.
- **Discord's rules:** client mods are against Discord's Terms of Service, so use this at your own risk.

Tested on Windows with Discord stable 1.0.9267. The Mac steps follow Equicord's standard install process but haven't been tested on a Mac.

## Update

From your Equicord folder:

```bash
git pull
git -C src/userplugins/AAB pull
pnpm install --frozen-lockfile
pnpm build
```

Then restart Discord.

## Uninstall

Turn off sharing first and wait a few seconds so the code is removed from your bio.

To remove only this plugin, delete `src/userplugins/AAB` from your Equicord folder, run `pnpm build`, and restart Discord.

To remove Equicord too, close Discord and run this from your Equicord folder:

```bash
pnpm uninject
```

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
