# Who's In

A tester version of Who's In: find London events and see which friends would go.

Live site: https://samcadbury.github.io/whos-in-london/

## How it works

- `index.html` is the app.
- Every morning a GitHub Action (`.github/workflows/update-events.yml`) runs `scripts/fetch-events.mjs`.
  It pulls London events for the next six weeks from the Ticketmaster Discovery API, adds your own picks
  from `data/manual-events.json`, saves them as `events.json` and publishes the site.
- If Ticketmaster can't be reached, the site keeps the previous day's events.
- Friends, plans and chats are still simulated and saved only in each visitor's browser.

## One-time setup

1. **Ticketmaster key:** sign up at https://developer.ticketmaster.com and copy the **Consumer Key** from *My Apps*.
2. **Store it as a secret:** on GitHub open the repository, then **Settings → Secrets and variables → Actions → New repository secret**.
   Name: `TICKETMASTER_API_KEY`. Secret: paste the Consumer Key. Click **Add secret**.
3. **Publish with GitHub Actions:** **Settings → Pages → Build and deployment → Source: GitHub Actions**.
4. **Run it once:** **Actions** tab → **Update events and publish site** → **Run workflow**. Wait for the green tick (about a minute).

After that it updates itself every day at 05:00 UTC and whenever you push a change.

## Adding your own events

Edit `data/manual-events.json`. Each event needs `title`, `cat` and either `days` (weekly) or `date` (one-off):

```json
{ "title": "Supper club", "cat": "food", "date": "2026-11-14", "time": "7:30pm",
  "venue": "Example Kitchen", "area": "Peckham", "region": "South", "price": "£25", "pmin": 25,
  "url": "https://example.com", "desc": "Five courses, shared tables." }
```

- `cat`: gigs, comedy, sport, theatre, clubs, food, markets or free
- `region`: Central, East, North, South or West
- `days`: for weekly events, for example `["sat"]` or `["sat", "sun"]`; optional `from` and `until` dates
- `time`: like `8pm`, `7:30pm` or `19:30`

Commit and push the change; the site updates within a couple of minutes.

## Notes

- GitHub pauses scheduled workflows in public repositories after 60 days without any commits. If that happens,
  GitHub emails you; re-enable it on the Actions tab or push any small change.
- Event listings come from Ticketmaster. Check the Ticketmaster Developer terms (branding and linking rules)
  before sharing the app widely or making money from it.
- Test locally: `TICKETMASTER_API_KEY=yourkey node scripts/fetch-events.mjs`, then serve the `_site` folder
  (copy `index.html` into it first). Never commit your key.
