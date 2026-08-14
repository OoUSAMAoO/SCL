# Star Cars — Railway deployment

This package turns the existing `index.html` into a Railway web app with a shared PostgreSQL database. The HTML already expects the `/api/*` server endpoints, so the UI is kept intact and the local-server backend is replaced with a Railway/hosted backend.

## Deploy

1. Create a Railway project.
2. Add a **PostgreSQL** service.
3. Deploy this repository as the app service.
4. Railway should provide `DATABASE_URL` to the app when the Postgres service is linked. If it does not, add it as a reference variable.
5. Deploy and open the generated public domain.
6. First login is `admin` / `admin` for a brand-new empty database. **Immediately use Change Password.**

The app listens on Railway's `PORT`, exposes `/health`, serves `public/index.html`, and implements the API paths used by the supplied HTML.

## Important data/sync behavior

- PostgreSQL is the source of truth instead of browser localStorage/Gist.
- Existing browser localStorage is not automatically uploaded on first load.
- The app uses optimistic version checks for full database saves.
- Section saves are supported for the existing Phase 2 sync code.
- Login and password changes are handled server-side.
- Locks/presence/activity are shared through the Railway process for normal use.

## Existing data migration

Use the app's **Backup** button to export your current JSON, then use **Restore (replace)** after deploying. This sends the restored database to `/api/db/restore-full`.

For a production migration, take a backup first and verify vehicles, sales, users, expenses and reports after restore.

## Recommended production settings

- Use a strong admin password.
- Keep the Railway Postgres service attached to the same project.
- Do not expose or commit GitHub tokens.
- If the app will have multiple Railway instances later, move locks/presence to a shared store such as Redis; the database itself is already shared.
