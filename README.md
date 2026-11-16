# wuji S2 -> S0 experiment reports

Static dashboards and comparison videos from the S2 capability-boundary exploration of the frozen
S0 dexterous-hand policy (AUTO3 Mixed `model_8000.pt`, Object-only).

- **Live site:** https://cunxid.github.io/wuji-s2-s0-report/
- `index.html` - the latest dashboard (self-contained: inline-SVG charts, embedded videos, light/dark).
- `compare_*.mp4` - side-by-side "gained ability" videos with the generated reference trajectory overlaid.
- `archive/<YYYY-MM-DD>/` - frozen snapshots of earlier reports.

Source of truth: the `s2/` tree on branch `jd/mixed-s0-s2` of the (private) training repo; this repo holds
only rendered report assets. Published from there with `s2/harness/publish_report.sh` - regenerate via
`pixi run python s2/harness/make_dashboard.py`, then publish.
