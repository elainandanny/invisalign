# Invisalign Tracker

A personal web app to track how long your Invisalign aligners are out each day. Built with vanilla JS + Supabase + Chart.js. Hosted on GitHub Pages.

## Features

- ⏱ Stopwatch with Start / Stop & Log
- 📅 Session log with date, EST time, and duration
- 📊 Graphs — daily out-time, day-of-week patterns, duration distribution
- 🗓 Calendar view with color-coded daily totals
- 🦷 Tray number tracking
- ⚠ Alerts when approaching or exceeding the 2-hour daily limit

---

## Setup

### 1. Supabase — Run the schema

1. Go to [supabase.com](https://supabase.com) → your project → **SQL Editor**
2. Paste the contents of `schema.sql` and click **Run**

### 2. GitHub Pages

1. Push this repo to GitHub
2. Go to **Settings → Pages**
3. Set source to **Deploy from a branch** → `main` → `/ (root)`
4. Your site will be live at `https://<your-username>.github.io/<repo-name>/`

> **Note:** GitHub Pages serves static files, so the ES module `import` in `app.js` works fine in modern browsers.

---

## File structure

```
invisalign-tracker/
├── index.html       # App shell
├── styles.css       # All styles
├── app.js           # App logic (stopwatch, views, Supabase calls)
├── config.js        # Supabase URL + key
├── schema.sql       # Run once in Supabase SQL Editor
└── README.md
```

---

## Customization

- **Daily limit**: Edit `MAX_OUT_SECONDS` in `config.js` (default: 7200 = 2 hours)
- **Timezone**: The app logs times in EST. Change `'America/New_York'` in `app.js` if needed.
