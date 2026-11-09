# Launch plan & pricing page

## Rollout funnel
![launch funnel](files/launch-funnel.drawio.svg)
## Timeline
```mermaid
gantt
    title GA Launch — Q3 2026
    dateFormat  YYYY-MM-DD
    section Beta
    Private beta          :active, b1, 2026-07-01, 45d
    Feedback triage       :b2, after b1, 20d
    section Launch
    Pricing page          :l1, 2026-08-15, 14d
    Launch announcement   :milestone, l2, 2026-09-15, 0d
```

## Pricing tiers
| Tier | Seats | API calls / mo | Price |
| --- | ---: | ---: | ---: |
| Free | 3 | 10,000 | $0 |
| Team | 20 | 250,000 | $49 |
| Business | unlimited | 2,000,000 | $199 |
| Enterprise | unlimited | custom | contact us |

## Conversion target
Expected conversion from waitlist to paid, assuming funnel rates $c_1$ (waitlist → beta) and $c_2$ (beta → paid):

```math
N_{paid} = N_{waitlist} \cdot c_1 \cdot c_2 = 1{,}800 \times 0.35 \times 0.42 \approx 265
```

> **Note:** $c_2 = 0.42$ comes from the design-partner survey (n = 20). Re-validate after the first beta cohort.

## Checklist

- [ ] Pricing page copy review with legal
- [ ] Status page & SLA doc
- [ ] Launch-day on-call rotation
- [x] Domain & SSL for marketing site
