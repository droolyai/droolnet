# Continuity Bureau · site deploy contract

**Public origin:** https://www.continuitybureau.com  
**Source of truth:** this directory (`repos/wokenet/site/`)  
**Local Vercel link (CLI):** project `wokesocial` · `prj_IKc2Hmwv1Ugi4BPAZJH4oEBkj0Ic`

## Why live may lag

Dogfood (2026-08-05) showed edge still serving **pre–Time Gods** WOKE.NET terminal HTML (`styles.css?v=20260804-3`, “WOKE.SOCIAL / PUBLIC RESEARCH TERMINAL”) while this folder already has CHRONAL chrome (`tg-seal-chronal`, `CB–01`, cache `styles.css?v=20260804-tg-chronal1`+).

Common causes:

1. **Git integration Root Directory** is monorepo root (`wokenet/`) instead of **`site`**.
2. Domain still attached to an **older wokesocial** deployment / different project.
3. Production deploy not triggered after `site/` CHRONAL landings (no agent production deploy without owner).

## Owner checklist (do not skip)

1. Vercel project for `www.continuitybureau.com` → **Root Directory = `site`**.
2. Framework preset: **Other** (static HTML/CSS/JS). No monorepo build required for the marketing site.
3. Confirm latest production deployment includes:
   - HTML body `class="tg-seal-chronal"`
   - Alert rail `CB–01 // CHRONAL`
   - Asset `/assets/continuity-bureau-mark-v3-128.png`
   - Response headers from `vercel.json`: `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy`, HSTS with `includeSubDomains; preload`
4. Redeploy production (dashboard or `vercel --prod` from `site/` with owner auth).
5. Verify:

```bash
curl -sI https://www.continuitybureau.com/ | rg -i 'cross-origin|strict-transport|HTTP/'
curl -sL https://www.continuitybureau.com/ | rg -o 'tg-seal-chronal|CB–01|tg-chronal'
```

## Agent rules

- **Never production-deploy** without owner / MoA gate.
- Keep headers honest and fail-closed; no secrets in this tree.
- Bump `?v=` cache on `index.html` / CSS / JS when shipping visible chrome changes.
