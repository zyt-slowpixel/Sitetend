# Changelog

All notable changes are listed here. Versions follow [Semantic Versioning](https://semver.org/).

## 1.3.0 (2026-11-20)

- **New entries in hand-written HTML.** Lists of same-shaped blocks (project cards, a timeline, a photo grid, table rows) can take a new entry: a copy of one block with its words, link and picture replaced, next to the others. A picture can be chosen on the card; it is saved next to the list's pictures. Menus, forms and blocks placed by pixel positions are left out.
- **Code changes from the chat.** When no field or list fits, the chat model can read a page and suggest a small find-and-replace change to its code. Each change is checked (exact matches only, nothing that adds scripts, event handlers, frames, forms or files from other websites, every element closed), shown in the live preview, and applied only when accepted, as one step that can be undone.
- **The same words in two places.** Accepting a text suggestion also updates exact copies of the old words in other files (for example a page and its phone version). The card says where.
- The live preview loads the page again when the site's files change, and has a Reload button. A page covered by a loading screen that its scripts remove is shown live.
- In the preview, SVG text is editable, and a part page that needs its scripts to show anything says so.

## 1.2.0 (2026-11-19)

- **Memory.** Sitetend keeps short notes about how you want your website written: preferences (wording and format, shared by all your websites) and decisions (what one website shows). Notes come from the conversation ("from now on…"), from the reason you give when rejecting a suggestion, or from making the same small change twice and answering *Remember*. They are listed, with their origin, under Settings → Advanced → Memory, where each can be edited, paused, moved to one website or removed; a suggestion that followed a note says which. Notes stay on your computer, are never published and are closed to coding agents.
- **Live preview.** A page drawn by its own scripts (a video intro, a canvas, a single-page app) used to look empty in the preview. It now switches to the real page with its scripts running, in a sandbox that cannot reach Sitetend; a selected suggestion is shown in place, unsaved, with the changed words highlighted. *Open in browser* does the same in a new tab. Fonts of the site now show in the normal preview too.
- A model is given the fitting notes after its usual instructions. With no notes, it receives exactly what it received in 1.1 (a test pins this).
- A wrong session token of a different length is now answered as such instead of as an internal error.
- When Cloudflare or Netlify refuses an upload, the message now includes the reason they gave.
- Netlify: the list of files to upload is taken only once Netlify has finished comparing. Cloudflare: `_routes.json` is left out, as it only applies with Functions.

## 1.1.0 (2026-11-17)

- **Publish to Cloudflare Pages.** Publish uploads the website straight to your Pages project (the same Direct Upload that dragging a folder into the dashboard uses), sending only the files that changed. Set up once with an API token, account ID and project name; *Test connection* checks them. Builds upload their output folder; a branch name makes a preview.
- **Publish to Netlify.** The same for Netlify sites (Netlify's file-digest deploys, as the Netlify CLI does): only changed files are sent, and *Upload as a preview only* makes a draft deploy that leaves the live site alone.
- Sites that use Cloudflare or Netlify Functions are not uploaded this way, so a deploy never takes their functions off the site.
- **Download website (.zip)** from the publish menu: the files at the top level, ready to drag into Cloudflare, Netlify Drop or another host. Secrets and Sitetend's own data are never included.
- The publish menu now stays above the preview's page picker.

## 1.0.0 (2026-11-16)

First public release.

**Keeping a website in sync with your materials**
- Drop in a resume, portfolio, project notes or a profile (PDF, Word, Markdown, text, JSON). Sitetend suggests the matching website edits, each with the sentence it came from. Nothing changes until you accept, and every change can be undone.
- Works with plain HTML sites, Jekyll, Hugo, Hexo, Eleventy, Quarto, Astro, React/Next/Vue/Svelte/Angular projects, server templates (PHP, Jinja, EJS and others), GitHub profile READMEs, and sites that need a build step.
- Models: a free rule demo, Ollama on your computer, or a key for Claude, OpenAI, Gemini or any OpenAI-compatible service. A second, independent review checks each suggestion. A monthly spending limit stops paid calls.
- Chat: ask for a change in your own words.
- Edits made in other tools (VS Code, coding agents) are recorded in history; a waiting suggestion whose spot was changed elsewhere becomes a conflict instead of overwriting it. Coding agents can also suggest changes through MCP.

**Safety**
- Daily full-site backups as a `.zip` in your user folder, restorable from Settings → Advanced → Backups.
- A save cut off by a power loss or a forced quit is finished the next time the site is opened; files are never left half-written.
- Pages in older encodings (GBK, Big5, Shift-JIS, Latin-1) and read-only files are left untouched.
- Keys are stored only in `~/.sitetend/.env`, never in the website or in settings files.

**Interface**
- English, Simplified Chinese, Traditional Chinese and Spanish; light and dark themes; keyboard access, visible focus and readable contrast; reduced motion is respected.
- A preview of the site with the suggested change in place, side by side with the current version; pages of multi-page sites; open the saved site in a browser with its own scripts running.
