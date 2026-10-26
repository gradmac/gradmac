# gradient goat

Zetamac for matrix calculus. You get a scalar function of a vector or matrix, type its gradient, and the next problem appears the instant you're right.

## Play

Open `public/index.html` in a browser to play offline. The leaderboard only appears when the site is served with its backend (see below).

## How it works

- **Checking answers.** Your expression is parsed and evaluated on random 3×3 matrices and compared with the true gradient, so any equivalent form counts.
- **Problems.** 92 hand-written problems across four levels (linear, quadratic, inverse, chain), plus generators that compose them with the chain rule, the product rule, sums and X → X⁻¹ substitution. Together that is roughly 1,900 distinct problems before letters are shuffled.
- **Solutions.** Every problem carries a derivation written in differentials (df = tr(G dX), then ∇f = Gᵀ). Each line is tagged with the rule it uses, and the parts that changed are highlighted.
- **Verification.** Every curated answer and every derivation line, plus thousands of generated problems, have been checked against finite-difference derivatives.

## Typing answers

| type | get |
|---|---|
| `'` or `^T` | ᵀ |
| `~` or `^-1` | ⁻¹ |
| `"` or `^-T` | ⁻ᵀ |
| `^2` | ² |
| `tr( det( norm( exp( log( softmax(` | functions |
| `I` | identity |

Letters written next to each other multiply. Tab skips a problem, and Esc quits a run.

## Convention

∇ₓf has the same shape as X, with entry (i, j) equal to ∂f/∂Xᵢⱼ. Gradients with respect to vectors are column vectors.

## Project layout

```
public/            the static site (index.html, fonts, _headers)
functions/api/     leaderboard API, run as a Cloudflare Pages Function
schema.sql         D1 database tables
wrangler.toml      Cloudflare config (D1 binding)
```

## Deploying on Cloudflare Pages

1. **Create the database.** In the Cloudflare dashboard, open **Storage & Databases → D1 → Create**, name it `gradmac`, then paste the contents of `schema.sql` into its **Console** and run it. Copy the database ID into `wrangler.toml`.
2. **Create the Pages project.** Go to **Workers & Pages → Create → Pages → Connect to Git** and pick this repo. Leave the build command empty and set the output directory to `public`.
3. **Add the domain.** Under **Custom domains**, add `gradmac.com`.

Every push to `main` deploys automatically.

## Accounts and leaderboard

- **Sign-in.** Players sign in with Google to post scores; playing needs no account. Sessions last a year, so returning players post with one tap.
- **Usernames.** Each Google account picks a username once, on first sign-in, and keeps it.
- **Tags.** Tags come only from Google Workspace accounts (school or work email, e.g. `@berkeley.edu` becomes **Berkeley**). Personal Gmail gets no tag. Showing the tag is the player's choice. Stored per user: Google's account ID, username, and the school or company domain. Never the email address.
- **Boards.** One board per level and duration, top 10 by each player's best, filterable to the player's own school or company.
- **Run checks.** A run gets a signed token when it starts. A score is accepted once per token, only after the full duration, and at most 1.2 points per second.

Google sign-in needs a Google Cloud OAuth client ID (a public value), set as `GOOGLE_CLIENT_ID` in `wrangler.toml`. Its authorized JavaScript origins must include every domain the site is served from.

To remove a player and their scores, run this in the D1 console:

```sql
DELETE FROM scores WHERE user_id = (SELECT id FROM users WHERE username = 'someone');
DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = 'someone');
DELETE FROM users WHERE username = 'someone';
```

## Running locally

```
npm install -g wrangler
wrangler d1 execute gradmac --local --file schema.sql
wrangler pages dev
```

## Credits

Source Code Pro by Adobe, under the SIL Open Font License (`public/fonts/OFL.txt`).
