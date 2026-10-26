# gradmac

Zetamac for matrix calculus. You get a scalar function of a vector or matrix, type its gradient, and the next problem appears the instant you're right.

## Play

Open `index.html` in a browser. There is no build step and no server code.

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

## Deploying

The site is static. On Cloudflare Pages, connect this repo with no build command and set the output directory to `/`. The `_headers` file adds a strict content security policy and other security headers.

## Credits

Source Code Pro by Adobe, under the SIL Open Font License (`fonts/OFL.txt`).
